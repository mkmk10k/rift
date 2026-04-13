#!/usr/bin/env python3
"""
Complete Chatterbox Turbo weight converter from PyTorch to MLX format.

Handles all transformations including:
- S3Gen decoder/encoder architecture remapping
- Weight normalization (parametrizations) reconstruction
- Speaker encoder (CAMPPlus) architecture mapping
- Conv weight transposition (1D and 2D)
- VoiceEncoder LSTM transformation
- T3 GPT2 attention transposition
"""

import re
import sys
import json
import shutil
import argparse
import numpy as np
from pathlib import Path
from typing import Dict, Tuple, Optional
from dataclasses import dataclass


def reconstruct_weight_norm(original0: np.ndarray, original1: np.ndarray) -> np.ndarray:
    """
    Reconstruct weight from weight normalization parameters.
    
    Weight normalization decomposes weight as: w = g * (v / ||v||)
    where g = original0 (gain) and v = original1 (direction)
    
    Args:
        original0: Gain tensor, shape typically (out_channels, 1, 1)
        original1: Direction tensor, shape (out_channels, in_channels, kernel_size)
    
    Returns:
        Reconstructed weight tensor
    """
    # Compute L2 norm of original1 along all but first axis
    axes = tuple(range(1, original1.ndim))
    norm = np.sqrt(np.sum(original1 ** 2, axis=axes, keepdims=True))
    norm = np.maximum(norm, 1e-12)  # Avoid division by zero
    
    # Reconstruct: weight = gain * (direction / ||direction||)
    normalized = original1 / norm
    weight = original0 * normalized
    
    return weight


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
    
    # final_block
    if 'final_block' in key:
        key = re.sub(r'final_block\.block\.0\.', 'final_block.block.0.conv.conv.', key)
        key = re.sub(r'final_block\.block\.2\.', 'final_block.block.1.', key)
    
    # final_proj: add .conv.
    if 'final_proj' in key and '.conv.' not in key:
        key = key.replace('final_proj.', 'final_proj.conv.')
    
    # Encoder embed: .embed.out.0. -> .embed.linear., .embed.out.1. -> .embed.norm.
    key = key.replace('.embed.out.0.', '.embed.linear.')
    key = key.replace('.embed.out.1.', '.embed.norm.')
    key = key.replace('.up_embed.out.0.', '.up_embed.linear.')
    key = key.replace('.up_embed.out.1.', '.up_embed.norm.')
    
    return key


def convert_mel2wav_key(pytorch_key: str) -> str:
    """Convert mel2wav key to MLX format."""
    key = pytorch_key
    
    # Skip weight normalization keys (handled separately)
    if 'parametrizations' in key:
        return None
    
    # Add .conv. wrapper for conv layers
    # mel2wav.conv_pre.bias -> mel2wav.conv_pre.conv.bias
    if key.startswith('mel2wav.'):
        # List of conv layers that need .conv. wrapper
        conv_layers = [
            'conv_pre', 'conv_post',
            'ups.0', 'ups.1', 'ups.2', 'ups.3',
            'source_downs.0', 'source_downs.1', 'source_downs.2',
        ]
        
        for layer in conv_layers:
            if f'mel2wav.{layer}.' in key and '.conv.' not in key:
                key = key.replace(f'mel2wav.{layer}.', f'mel2wav.{layer}.conv.')
        
        # source_resblocks pattern (check first to avoid double matching)
        # source_resblocks.X.convsY.Z -> source_resblocks.X.convsY.Z.conv.
        if 'source_resblocks' in key and '.conv.' not in key:
            key = re.sub(r'source_resblocks\.(\d+)\.(convs\d+)\.(\d+)\.', r'source_resblocks.\1.\2.\3.conv.', key)
        
        # resblocks.X.convsY.Z -> resblocks.X.convsY.Z.conv.
        elif 'resblocks' in key and '.conv.' not in key:
            key = re.sub(r'resblocks\.(\d+)\.(convs\d+)\.(\d+)\.', r'resblocks.\1.\2.\3.conv.', key)
        
        # f0_predictor.condnet: PyTorch uses 0,2,4,6,8 (odd indices are activations)
        # MLX uses 0,1,2,3,4 - need to map X -> X//2
        match = re.search(r'f0_predictor\.condnet\.(\d+)\.', key)
        if match:
            idx = int(match.group(1))
            new_idx = idx // 2  # 0->0, 2->1, 4->2, etc.
            key = key.replace(f'condnet.{idx}.', f'condnet.{new_idx}.conv.')
    
    return key


def convert_speaker_encoder_key(pytorch_key: str) -> str:
    """Convert speaker_encoder (CAMPPlus) key to MLX format."""
    key = pytorch_key
    
    if not key.startswith('speaker_encoder.'):
        return key
    
    # Skip num_batches_tracked
    if 'num_batches_tracked' in key:
        return None
    
    # Block mapping: xvector.block1 -> blocks.0, block2 -> blocks.1, block3 -> blocks.2
    key = key.replace('xvector.block1.', 'blocks.0.')
    key = key.replace('xvector.block2.', 'blocks.1.')
    key = key.replace('xvector.block3.', 'blocks.2.')
    
    # TDNND layers: tdnnd1 -> layers.0, tdnnd2 -> layers.1, etc.
    # Handle tdnnd with numbers 1-24 (block2 has up to 24 layers)
    # Process in reverse order to handle tdnnd24 before tdnnd2
    for i in range(24, 0, -1):
        key = key.replace(f'.tdnnd{i}.', f'.layers.{i-1}.')
    
    # BatchNorm mapping: nonlinear1.batchnorm. -> bn1., nonlinear2.batchnorm. -> bn2.
    key = key.replace('.nonlinear1.batchnorm.', '.bn1.')
    key = key.replace('.nonlinear2.batchnorm.', '.bn2.')
    
    # Transit mapping: xvector.transit1 -> transits.0, etc
    key = key.replace('xvector.transit1.', 'transits.0.')
    key = key.replace('xvector.transit2.', 'transits.1.')
    key = key.replace('xvector.transit3.', 'transits.2.')
    
    # xvector.tdnn -> tdnn
    key = key.replace('xvector.tdnn.', 'tdnn.')
    
    # xvector.out_nonlinear -> out_bn
    key = key.replace('xvector.out_nonlinear.', 'out_bn.')
    # Also handle batchnorm inside out_nonlinear
    key = key.replace('out_bn.batchnorm.', 'out_bn.')
    
    # xvector.dense -> dense
    key = key.replace('xvector.dense.', 'dense.')
    
    # Dense layer structure
    if 'dense.' in key:
        key = key.replace('dense.0.', 'dense.bn.')
        key = key.replace('dense.1.', 'dense.linear.')
        key = key.replace('dense.bn.batchnorm.', 'dense.bn.')
        key = key.replace('dense.nonlinear.batchnorm.', 'dense.bn.')
    
    # Head shortcut: .shortcut.0. -> .shortcut_conv., .shortcut.1. -> .shortcut_bn.
    if '.head.' in key:
        key = key.replace('.shortcut.0.', '.shortcut_conv.')
        key = key.replace('.shortcut.1.', '.shortcut_bn.')
    
    # TDNN structure: .nonlinear.batchnorm. -> .bn.
    if 'speaker_encoder.tdnn.' in key:
        key = key.replace('tdnn.0.', 'tdnn.linear.')
        key = key.replace('tdnn.1.', 'tdnn.bn.')
        key = key.replace('tdnn.bn.batchnorm.', 'tdnn.bn.')
        key = key.replace('tdnn.nonlinear.batchnorm.', 'tdnn.bn.')
    
    # Transit structure: .nonlinear.batchnorm. -> .bn.
    if 'transits.' in key:
        key = re.sub(r'transits\.(\d+)\.0\.', r'transits.\1.linear.', key)
        key = re.sub(r'transits\.(\d+)\.1\.', r'transits.\1.bn.', key)
        key = re.sub(r'transits\.(\d+)\.bn\.batchnorm\.', r'transits.\1.bn.', key)
        key = re.sub(r'transits\.(\d+)\.nonlinear\.batchnorm\.', r'transits.\1.bn.', key)
    
    return key


def convert_ve_weights(ve_weights: Dict[str, np.ndarray]) -> Dict[str, np.ndarray]:
    """
    Convert VoiceEncoder weights from PyTorch to MLX format.
    
    PyTorch LSTM: lstm.weight_ih_l{layer}, lstm.weight_hh_l{layer}, lstm.bias_*
    MLX LSTM: lstm{layer+1}.Wx, lstm{layer+1}.Wh, lstm{layer+1}.bias
    """
    converted = {}
    layer_map = {0: 1, 1: 2, 2: 3}
    
    for pt_layer, mlx_layer in layer_map.items():
        ih_key = f"lstm.weight_ih_l{pt_layer}"
        if ih_key in ve_weights:
            converted[f"lstm{mlx_layer}.Wx"] = ve_weights[ih_key]
        
        hh_key = f"lstm.weight_hh_l{pt_layer}"
        if hh_key in ve_weights:
            converted[f"lstm{mlx_layer}.Wh"] = ve_weights[hh_key]
        
        bias_ih_key = f"lstm.bias_ih_l{pt_layer}"
        bias_hh_key = f"lstm.bias_hh_l{pt_layer}"
        if bias_ih_key in ve_weights and bias_hh_key in ve_weights:
            converted[f"lstm{mlx_layer}.bias"] = ve_weights[bias_ih_key] + ve_weights[bias_hh_key]
    
    # Copy other weights directly
    for key in ["proj.weight", "proj.bias", "similarity_weight", "similarity_bias"]:
        if key in ve_weights:
            converted[key] = ve_weights[key]
    
    return converted


def convert_t3_weights(t3_weights: Dict[str, np.ndarray]) -> Dict[str, np.ndarray]:
    """
    Convert T3 (GPT2) weights - transpose attention/MLP weights.
    """
    converted = {}
    
    for key, weight in t3_weights.items():
        new_weight = weight
        
        # GPT2 attention weights need transpose: (in, out) -> (out, in)
        if any(x in key for x in ['.c_attn.weight', '.c_proj.weight', '.c_fc.weight']):
            if weight.ndim == 2:
                new_weight = weight.T
        
        converted[key] = new_weight
    
    return converted


def convert_all_weights(pytorch_weights: Dict[str, np.ndarray]) -> Dict[str, np.ndarray]:
    """
    Convert all weights with proper handling of weight normalization.
    """
    converted = {}
    
    # First, handle weight normalization by reconstructing weights
    wn_groups = {}
    regular_keys = []
    
    for key in pytorch_weights.keys():
        if 'parametrizations.weight.original' in key:
            # Group by base key
            base = key.replace('.parametrizations.weight.original0', '').replace('.parametrizations.weight.original1', '')
            if base not in wn_groups:
                wn_groups[base] = {}
            if 'original0' in key:
                wn_groups[base]['original0'] = pytorch_weights[key]
            else:
                wn_groups[base]['original1'] = pytorch_weights[key]
        else:
            regular_keys.append(key)
    
    # Reconstruct weight-normalized tensors
    for base, parts in wn_groups.items():
        if 'original0' in parts and 'original1' in parts:
            weight = reconstruct_weight_norm(parts['original0'], parts['original1'])
            # Convert key
            mlx_key = convert_mel2wav_key(base + '.weight')
            if mlx_key:
                # Transpose Conv1d: (O, I, K) -> (O, K, I)
                # BUT ConvTranspose1d (ups): (I, O, K) -> (O, K, I)
                if weight.ndim == 3:
                    if '.ups.' in mlx_key:
                        # ConvTranspose1d: (in, out, kernel) -> (out, kernel, in)
                        weight = np.transpose(weight, (1, 2, 0))
                    else:
                        # Conv1d: (out, in, kernel) -> (out, kernel, in)
                        weight = np.transpose(weight, (0, 2, 1))
                converted[mlx_key] = weight
    
    # Process regular keys
    for key in regular_keys:
        value = pytorch_weights[key]
        
        # Determine which converter to use based on prefix
        if key.startswith('flow.') or key.startswith('encoder.') or key.startswith('decoder.'):
            mlx_key = convert_s3gen_key(key)
        elif key.startswith('mel2wav.'):
            mlx_key = convert_mel2wav_key(key)
        elif key.startswith('speaker_encoder.'):
            mlx_key = convert_speaker_encoder_key(key)
        else:
            mlx_key = key
        
        if mlx_key is None:
            continue
        
        # Transpose weights as needed
        if value.ndim == 3 and mlx_key.endswith('.weight'):
            # Conv1d: (O, I, K) -> (O, K, I)
            value = np.transpose(value, (0, 2, 1))
        elif value.ndim == 4 and mlx_key.endswith('.weight') and 'speaker_encoder' in mlx_key:
            # Conv2d: (O, I, H, W) -> (O, H, W, I)
            value = np.transpose(value, (0, 2, 3, 1))
        
        converted[mlx_key] = value
    
    return converted


def load_and_convert_turbo(cache_dir: Optional[Path] = None) -> Tuple[Dict, Dict, Dict, Dict]:
    """
    Load all Chatterbox Turbo weights and convert to MLX format.
    
    Returns:
        Tuple of (ve_weights, t3_weights, s3gen_weights, conds_weights)
    """
    from safetensors.numpy import load_file as np_load
    from huggingface_hub import snapshot_download
    import torch
    
    if cache_dir is None:
        cache_dir = Path.home() / ".cache" / "chatterbox-turbo-convert"
    
    print("Downloading Chatterbox Turbo weights...")
    ckpt_dir = Path(snapshot_download(
        repo_id="ResembleAI/chatterbox-turbo",
        allow_patterns=["*.safetensors", "*.json", "*.pt", "*.txt"],
        cache_dir=cache_dir,
    ))
    print(f"Downloaded to: {ckpt_dir}")
    
    # Load VoiceEncoder
    print("\nLoading VoiceEncoder...")
    ve_path = ckpt_dir / "ve.safetensors"
    ve_weights_raw = np_load(ve_path) if ve_path.exists() else {}
    ve_weights = convert_ve_weights(ve_weights_raw)
    print(f"  Converted {len(ve_weights_raw)} -> {len(ve_weights)} VE weights")
    
    # Load T3
    print("\nLoading T3...")
    t3_path = ckpt_dir / "t3_turbo_v1.safetensors"
    t3_weights_raw = np_load(t3_path) if t3_path.exists() else {}
    t3_weights = convert_t3_weights(t3_weights_raw)
    print(f"  Converted {len(t3_weights_raw)} -> {len(t3_weights)} T3 weights")
    
    # Load S3Gen
    print("\nLoading S3Gen...")
    s3gen_path = ckpt_dir / "s3gen_meanflow.safetensors"
    if not s3gen_path.exists():
        s3gen_path = ckpt_dir / "s3gen.safetensors"
    s3gen_weights_raw = np_load(s3gen_path) if s3gen_path.exists() else {}
    s3gen_weights = convert_all_weights(s3gen_weights_raw)
    print(f"  Converted {len(s3gen_weights_raw)} -> {len(s3gen_weights)} S3Gen weights")
    
    # Load conditionals
    print("\nLoading conditionals...")
    conds_path = ckpt_dir / "conds.pt"
    conds_weights = {}
    if conds_path.exists():
        conds = torch.load(conds_path, map_location="cpu", weights_only=True)
        
        if "t3" in conds:
            t3 = conds["t3"]
            if "speaker_emb" in t3:
                conds_weights["t3.speaker_emb"] = t3["speaker_emb"].detach().numpy()
            if "cond_prompt_speech_tokens" in t3:
                conds_weights["t3.cond_prompt_speech_tokens"] = t3["cond_prompt_speech_tokens"].detach().numpy().astype(np.int64)
            if "emotion_adv" in t3:
                conds_weights["t3.emotion_adv"] = t3["emotion_adv"].detach().numpy()
        
        if "gen" in conds:
            for k, v in conds["gen"].items():
                if hasattr(v, "detach"):
                    v = v.detach()
                    if v.dtype == torch.long:
                        conds_weights[f"gen.{k}"] = v.numpy().astype(np.int64)
                    else:
                        conds_weights[f"gen.{k}"] = v.numpy()
                elif isinstance(v, (int, float)):
                    conds_weights[f"gen.{k}"] = np.array([v])
        
        print(f"  Loaded {len(conds_weights)} conditional tensors")
    
    return ve_weights, t3_weights, s3gen_weights, conds_weights, ckpt_dir


def save_converted_model(
    output_dir: Path,
    ve_weights: Dict,
    t3_weights: Dict,
    s3gen_weights: Dict,
    conds_weights: Dict,
    ckpt_dir: Path,
):
    """Save converted weights to output directory."""
    from safetensors.numpy import save_file as np_save
    
    output_dir.mkdir(parents=True, exist_ok=True)
    
    # Combine all model weights with proper prefixes
    all_weights = {}
    for k, v in ve_weights.items():
        all_weights[f"ve.{k}"] = v
    for k, v in t3_weights.items():
        all_weights[f"t3.{k}"] = v
    for k, v in s3gen_weights.items():
        # S3Gen weights already have proper prefixes
        if not k.startswith(('decoder.', 'encoder.', 'mel2wav.', 'speaker_encoder.', 'tokenizer.')):
            all_weights[f"s3gen.{k}"] = v
        else:
            all_weights[k] = v
    
    # Clean up dtypes
    for k in all_weights:
        if all_weights[k].dtype == np.float64:
            all_weights[k] = all_weights[k].astype(np.float32)
    
    print(f"\nSaving model.safetensors ({len(all_weights)} tensors)...")
    np_save(all_weights, output_dir / "model.safetensors")
    
    # Save conditionals
    if conds_weights:
        for k in conds_weights:
            if conds_weights[k].dtype == np.float64:
                conds_weights[k] = conds_weights[k].astype(np.float32)
        print(f"Saving conds.safetensors ({len(conds_weights)} tensors)...")
        np_save(conds_weights, output_dir / "conds.safetensors")
    
    # Copy tokenizer files
    print("Copying tokenizer files...")
    for fname in ["tokenizer.json", "vocab.json", "merges.txt", "tokenizer_config.json",
                  "added_tokens.json", "special_tokens_map.json"]:
        src = ckpt_dir / fname
        if src.exists():
            shutil.copy(src, output_dir / fname)
    
    # Create config
    config = {
        "model_type": "chatterbox_turbo",
        "version": "1.0-converted",
        "sample_rate": 24000,
    }
    with open(output_dir / "config.json", "w") as f:
        json.dump(config, f, indent=2)
    
    print(f"\n✅ Saved to {output_dir}")


def validate_against_mlx(s3gen_weights: Dict) -> dict:
    """Validate converted S3Gen weights against MLX model."""
    from mlx_audio.tts.models.chatterbox_turbo.models.s3gen import S3Gen
    from mlx.utils import tree_flatten
    
    s3gen = S3Gen(meanflow=True)
    mlx_params = dict(tree_flatten(s3gen.parameters()))
    
    converted_keys = set(s3gen_weights.keys())
    mlx_keys = set(mlx_params.keys())
    
    matched = converted_keys & mlx_keys
    missing = mlx_keys - converted_keys
    extra = converted_keys - mlx_keys
    
    # Check shapes
    shape_ok = 0
    shape_mismatch = []
    for k in matched:
        mlx_shape = tuple(mlx_params[k].shape)
        conv_shape = s3gen_weights[k].shape
        if mlx_shape == conv_shape:
            shape_ok += 1
        else:
            shape_mismatch.append((k, conv_shape, mlx_shape))
    
    return {
        'matched': len(matched),
        'total': len(mlx_keys),
        'missing': len(missing),
        'extra': len(extra),
        'shape_ok': shape_ok,
        'shape_mismatch': shape_mismatch,
        'percent': 100 * len(matched) / len(mlx_keys) if mlx_keys else 0,
        'missing_keys': sorted(missing)[:20],
    }


def main():
    parser = argparse.ArgumentParser(description="Convert Chatterbox Turbo to MLX")
    parser.add_argument("--output", type=Path, default=Path("./Chatterbox-Turbo-MLX"),
                       help="Output directory")
    parser.add_argument("--validate-only", action="store_true",
                       help="Only validate, don't save")
    args = parser.parse_args()
    
    ve_weights, t3_weights, s3gen_weights, conds_weights, ckpt_dir = load_and_convert_turbo()
    
    # Validate S3Gen
    print("\n=== Validating S3Gen conversion ===")
    stats = validate_against_mlx(s3gen_weights)
    print(f"Matched: {stats['matched']}/{stats['total']} ({stats['percent']:.1f}%)")
    print(f"Shape OK: {stats['shape_ok']}/{stats['matched']}")
    print(f"Missing: {stats['missing']}")
    print(f"Extra: {stats['extra']}")
    
    if stats['shape_mismatch']:
        print("\nShape mismatches (first 5):")
        for k, conv, mlx in stats['shape_mismatch'][:5]:
            print(f"  {k}: converted {conv} vs MLX {mlx}")
    
    if stats['missing_keys']:
        print("\nMissing keys (first 10):")
        for k in stats['missing_keys'][:10]:
            print(f"  {k}")
    
    if not args.validate_only:
        save_converted_model(args.output, ve_weights, t3_weights, s3gen_weights, conds_weights, ckpt_dir)
    
    return 0


if __name__ == "__main__":
    sys.exit(main())
