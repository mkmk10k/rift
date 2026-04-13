#!/usr/bin/env python3
"""
Complete S3Gen weight converter from PyTorch to MLX format.

Key mappings:
- flow.decoder -> decoder
- .X.0.block -> .X.resnet.block  (resnet blocks)
- .X.1.Y. -> .X.transformer_blocks.Y. (transformer blocks)
- .X.2. -> .X.downsample.conv.conv. (downsamples)
- .ff.net.2. -> .ff.net.1. (feed-forward)
- .block.0. -> .block.0.conv.conv. (conv in blocks)
- .block.2. -> .block.1. (norm in blocks)
- Conv weights: transpose (O,I,K) -> (O,K,I)
"""

import re
import numpy as np
from pathlib import Path
from typing import Dict


def convert_s3gen_key(pytorch_key: str) -> str:
    """Convert PyTorch S3Gen key to MLX format."""
    key = pytorch_key
    
    # Remove flow. prefix
    if key.startswith("flow."):
        key = key[5:]
    
    # Handle different block types in down_blocks, mid_blocks, up_blocks
    for block_type in ['down_blocks', 'mid_blocks', 'up_blocks']:
        # Resnet blocks: .X.0. -> .X.resnet.
        key = re.sub(rf'{block_type}\.(\d+)\.0\.block', rf'{block_type}.\1.resnet.block', key)
        key = re.sub(rf'{block_type}\.(\d+)\.0\.mlp', rf'{block_type}.\1.resnet.mlp', key)
        key = re.sub(rf'{block_type}\.(\d+)\.0\.res_conv', rf'{block_type}.\1.resnet.res_conv', key)
        
        # Transformer blocks: .X.1.Y. -> .X.transformer_blocks.Y.
        key = re.sub(rf'{block_type}\.(\d+)\.1\.(\d+)\.', rf'{block_type}.\1.transformer_blocks.\2.', key)
    
    # Downsample: down_blocks.X.2. -> down_blocks.X.downsample.conv.conv.
    key = re.sub(r'down_blocks\.(\d+)\.2\.', r'down_blocks.\1.downsample.conv.conv.', key)
    
    # Upsample: up_blocks.X.2. -> up_blocks.X.upsample.conv.conv.
    key = re.sub(r'up_blocks\.(\d+)\.2\.', r'up_blocks.\1.upsample.conv.conv.', key)
    
    # Feed-forward: .ff.net.2. -> .ff.net.1.
    key = re.sub(r'\.ff\.net\.2\.', '.ff.net.1.', key)
    
    # Conv in resnet blocks: .block.0. -> .block.0.conv.conv.
    key = re.sub(r'\.block(\d)\.block\.0\.', r'.block\1.block.0.conv.conv.', key)
    
    # Norm in resnet blocks: .block.2. -> .block.1.
    key = re.sub(r'\.block(\d)\.block\.2\.', r'.block\1.block.1.', key)
    
    # res_conv: add .conv.
    if '.res_conv.' in key and '.conv.' not in key.split('.res_conv.')[1]:
        key = key.replace('.res_conv.', '.res_conv.conv.')
    
    # time_mlp: .1. -> .linear_1., .3. -> .linear_2.
    key = key.replace('time_mlp.1.', 'time_mlp.linear_1.')
    key = key.replace('time_mlp.3.', 'time_mlp.linear_2.')
    
    # mlp in resnet: .mlp.1. -> .mlp.0.
    key = re.sub(r'\.mlp\.1\.', '.mlp.0.', key)
    
    # final_block: .block.0. -> .block.0.conv.conv., .block.2. -> .block.1.
    if 'final_block' in key:
        key = re.sub(r'final_block\.block\.0\.', 'final_block.block.0.conv.conv.', key)
        key = re.sub(r'final_block\.block\.2\.', 'final_block.block.1.', key)
    
    # final_proj: add .conv.
    if 'final_proj' in key and '.conv.' not in key:
        key = key.replace('final_proj.', 'final_proj.conv.')
    
    # Encoder embed: .embed.out.0. -> .embed.linear., .embed.out.1. -> .embed.norm.
    key = key.replace('.embed.out.0.', '.embed.linear.')
    key = key.replace('.embed.out.1.', '.embed.norm.')
    
    # up_embed: similar pattern
    key = key.replace('.up_embed.out.0.', '.up_embed.linear.')
    key = key.replace('.up_embed.out.1.', '.up_embed.norm.')
    
    # pre_lookahead_layer: .0. -> .conv1., .2. -> .conv2.
    key = key.replace('.pre_lookahead_layer.0.', '.pre_lookahead_layer.conv1.')
    key = key.replace('.pre_lookahead_layer.2.', '.pre_lookahead_layer.conv2.')
    
    # up_layer: .0. -> .conv.
    if '.up_layer.0.' in key:
        key = key.replace('.up_layer.0.', '.up_layer.conv.')
    
    return key


def convert_s3gen_weights(pytorch_weights: Dict[str, np.ndarray]) -> Dict[str, np.ndarray]:
    """
    Convert all S3Gen weights from PyTorch to MLX format.
    
    Args:
        pytorch_weights: Dictionary of PyTorch weights
        
    Returns:
        Dictionary of MLX-compatible weights
    """
    converted = {}
    
    for pt_key, value in pytorch_weights.items():
        mlx_key = convert_s3gen_key(pt_key)
        
        # Transpose conv weights: (O, I, K) -> (O, K, I)
        if value.ndim == 3 and mlx_key.endswith('.weight'):
            value = np.transpose(value, (0, 2, 1))
        
        converted[mlx_key] = value
    
    return converted


def validate_conversion(converted: Dict[str, np.ndarray], mlx_params: Dict) -> dict:
    """
    Validate converted weights against MLX model parameters.
    
    Returns dictionary with match statistics.
    """
    converted_keys = set(converted.keys())
    mlx_keys = set(mlx_params.keys())
    
    matched = converted_keys & mlx_keys
    missing = mlx_keys - converted_keys
    extra = converted_keys - mlx_keys
    
    # Check shape mismatches
    shape_mismatches = []
    for key in matched:
        mlx_shape = tuple(mlx_params[key].shape)
        conv_shape = converted[key].shape
        if mlx_shape != conv_shape:
            shape_mismatches.append((key, conv_shape, mlx_shape))
    
    return {
        'matched': len(matched),
        'total': len(mlx_keys),
        'missing': list(sorted(missing)),
        'extra': list(sorted(extra)),
        'shape_mismatches': shape_mismatches,
        'match_percent': 100 * len(matched) / len(mlx_keys) if mlx_keys else 0
    }


if __name__ == "__main__":
    from safetensors.numpy import load_file as np_load, save_file as np_save
    from huggingface_hub import snapshot_download
    
    print("Loading PyTorch S3Gen weights...")
    ckpt_dir = Path(snapshot_download(
        repo_id="ResembleAI/chatterbox-turbo",
        allow_patterns=["s3gen*.safetensors"],
    ))
    pytorch_weights = np_load(ckpt_dir / "s3gen_meanflow.safetensors")
    
    print(f"Converting {len(pytorch_weights)} weights...")
    converted = convert_s3gen_weights(pytorch_weights)
    
    # Validate
    from mlx_audio.tts.models.chatterbox_turbo.models.s3gen import S3Gen
    from mlx.utils import tree_flatten
    
    s3gen = S3Gen(meanflow=True)
    mlx_params = dict(tree_flatten(s3gen.parameters()))
    
    stats = validate_conversion(converted, mlx_params)
    print(f"\nMatch: {stats['matched']}/{stats['total']} ({stats['match_percent']:.1f}%)")
    print(f"Missing: {len(stats['missing'])}")
    print(f"Extra: {len(stats['extra'])}")
    print(f"Shape mismatches: {len(stats['shape_mismatches'])}")
    
    if stats['missing'][:5]:
        print("\nMissing (first 5):")
        for k in stats['missing'][:5]:
            print(f"  {k}")
