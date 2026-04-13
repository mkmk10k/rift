#!/usr/bin/env python3
"""
Convert Chatterbox Turbo weights from PyTorch to MLX format.

This script handles the key transformations:
1. VoiceEncoder LSTM: PyTorch combined weights -> MLX separate Wx, Wh, bias
2. T3 GPT2 attention: Transpose weights from (in, out) to (out, in)
3. S3Gen: Apply sanitize method for weight remapping

Usage:
    python convert_chatterbox_turbo.py --output ./Chatterbox-Turbo-converted
"""

import argparse
import json
import shutil
from pathlib import Path
from typing import Dict

import numpy as np


def download_turbo_weights(cache_dir: Path) -> Path:
    """Download Chatterbox Turbo weights from HuggingFace."""
    from huggingface_hub import snapshot_download

    print("Downloading Chatterbox Turbo weights from HuggingFace...")
    ckpt_dir = Path(
        snapshot_download(
            repo_id="ResembleAI/chatterbox-turbo",
            allow_patterns=[
                "*.safetensors",
                "*.json",
                "*.txt",
                "*.pt",
                "*.yaml",
            ],
            cache_dir=cache_dir,
        )
    )
    print(f"Downloaded to: {ckpt_dir}")
    return ckpt_dir


def load_pytorch_safetensors(path: Path) -> Dict[str, np.ndarray]:
    """Load PyTorch safetensors and convert to numpy."""
    from safetensors.torch import load_file

    state_dict = load_file(path)
    return {k: v.cpu().numpy() for k, v in state_dict.items()}


def load_pytorch_conds(path: Path) -> Dict[str, np.ndarray]:
    """Load conds.pt and convert to numpy."""
    import torch
    
    print(f"Loading conditionals from {path}...")
    conds = torch.load(path, map_location="cpu", weights_only=True)
    
    result = {}
    
    # t3 conditionals
    if "t3" in conds:
        t3 = conds["t3"]
        if "speaker_emb" in t3:
            result["t3.speaker_emb"] = t3["speaker_emb"].detach().numpy()
        if "cond_prompt_speech_tokens" in t3:
            result["t3.cond_prompt_speech_tokens"] = t3["cond_prompt_speech_tokens"].detach().numpy().astype(np.int64)
        if "emotion_adv" in t3:
            result["t3.emotion_adv"] = t3["emotion_adv"].detach().numpy()
    
    # gen conditionals
    if "gen" in conds:
        gen = conds["gen"]
        for k, v in gen.items():
            if hasattr(v, "detach"):
                if v.dtype == torch.long:
                    result[f"gen.{k}"] = v.detach().numpy().astype(np.int64)
                else:
                    result[f"gen.{k}"] = v.detach().numpy()
            elif isinstance(v, (int, float)):
                result[f"gen.{k}"] = np.array([v])
    
    print(f"  Extracted {len(result)} conditional tensors")
    for k, v in result.items():
        print(f"    {k}: shape={v.shape}, dtype={v.dtype}")
    
    return result


def convert_ve_weights(ve_weights: Dict[str, np.ndarray]) -> Dict[str, np.ndarray]:
    """
    Convert VoiceEncoder weights from PyTorch to MLX format.
    
    PyTorch LSTM format:
        lstm.weight_ih_l{layer}: (4*hidden, input)  -> input-hidden weights
        lstm.weight_hh_l{layer}: (4*hidden, hidden) -> hidden-hidden weights
        lstm.bias_ih_l{layer}: (4*hidden,)
        lstm.bias_hh_l{layer}: (4*hidden,)
    
    MLX LSTM format (separate cells):
        lstm{layer+1}.Wx: (4*hidden, input)  -> same as weight_ih
        lstm{layer+1}.Wh: (4*hidden, hidden) -> same as weight_hh  
        lstm{layer+1}.bias: (4*hidden,)      -> bias_ih + bias_hh
    """
    converted = {}
    
    # Map layers: PyTorch l0->MLX lstm1, l1->lstm2, l2->lstm3
    layer_map = {0: 1, 1: 2, 2: 3}
    
    for pt_layer, mlx_layer in layer_map.items():
        # Input weights: weight_ih -> Wx
        ih_key = f"lstm.weight_ih_l{pt_layer}"
        if ih_key in ve_weights:
            converted[f"lstm{mlx_layer}.Wx"] = ve_weights[ih_key]
        
        # Hidden weights: weight_hh -> Wh
        hh_key = f"lstm.weight_hh_l{pt_layer}"
        if hh_key in ve_weights:
            converted[f"lstm{mlx_layer}.Wh"] = ve_weights[hh_key]
        
        # Bias: bias_ih + bias_hh -> bias
        bias_ih_key = f"lstm.bias_ih_l{pt_layer}"
        bias_hh_key = f"lstm.bias_hh_l{pt_layer}"
        if bias_ih_key in ve_weights and bias_hh_key in ve_weights:
            converted[f"lstm{mlx_layer}.bias"] = ve_weights[bias_ih_key] + ve_weights[bias_hh_key]
    
    # Copy proj and similarity weights directly
    for key in ["proj.weight", "proj.bias", "similarity_weight", "similarity_bias"]:
        if key in ve_weights:
            converted[key] = ve_weights[key]
    
    return converted


def convert_t3_weights(t3_weights: Dict[str, np.ndarray]) -> Dict[str, np.ndarray]:
    """
    Convert T3 (GPT2) weights from PyTorch to MLX format.
    
    Key transformations:
    - Transpose c_attn weights: (in, out) -> (out, in) for linear layers
    - Transpose c_proj weights similarly
    - Transpose mlp c_fc and c_proj weights
    """
    converted = {}
    
    for key, weight in t3_weights.items():
        new_key = key
        new_weight = weight
        
        # GPT2 attention weights need transpose
        if ".attn.c_attn.weight" in key:
            # Combined QKV projection: (hidden, 3*hidden) -> (3*hidden, hidden)
            new_weight = weight.T
        elif ".attn.c_proj.weight" in key:
            # Output projection: (hidden, hidden) -> (hidden, hidden)
            new_weight = weight.T
        elif ".mlp.c_fc.weight" in key:
            # MLP first layer: (hidden, 4*hidden) -> (4*hidden, hidden)
            new_weight = weight.T
        elif ".mlp.c_proj.weight" in key:
            # MLP second layer: (4*hidden, hidden) -> (hidden, 4*hidden)
            new_weight = weight.T
        
        converted[new_key] = new_weight
    
    return converted


def save_mlx_safetensors(weights: Dict[str, np.ndarray], path: Path):
    """Save weights as MLX-compatible safetensors."""
    from safetensors.numpy import save_file

    clean_weights = {}
    for k, v in weights.items():
        if isinstance(v, np.ndarray):
            if v.dtype == np.float64:
                v = v.astype(np.float32)
            clean_weights[k] = v
        else:
            clean_weights[k] = np.array(v)

    save_file(clean_weights, path)
    print(f"Saved: {path} ({len(clean_weights)} tensors)")


def convert_turbo(
    output_dir: Path,
    cache_dir: Path = None,
):
    """
    Convert Chatterbox Turbo weights to MLX format.
    
    Creates:
    - model.safetensors: Combined weights (ve.*, t3.*, s3gen.*)
    - conds.safetensors: Built-in voice conditioning
    - tokenizer files, config.json
    """
    import mlx.core as mx
    from mlx_audio.tts.models.chatterbox_turbo.models.s3gen import S3Gen
    
    if cache_dir is None:
        cache_dir = Path.home() / ".cache" / "chatterbox-turbo-convert"
    
    output_dir.mkdir(parents=True, exist_ok=True)
    
    # Download weights
    ckpt_dir = download_turbo_weights(cache_dir)
    
    all_weights = {}
    
    # Convert VoiceEncoder
    print("\nConverting VoiceEncoder...")
    ve_path = ckpt_dir / "ve.safetensors"
    if ve_path.exists():
        ve_weights = load_pytorch_safetensors(ve_path)
        ve_converted = convert_ve_weights(ve_weights)
        for k, v in ve_converted.items():
            all_weights[f"ve.{k}"] = v
        print(f"  Converted {len(ve_weights)} -> {len(ve_converted)} VoiceEncoder weights")
    else:
        print(f"  WARNING: {ve_path} not found")
    
    # Convert T3
    print("\nConverting T3...")
    t3_path = ckpt_dir / "t3_turbo_v1.safetensors"
    if t3_path.exists():
        t3_weights = load_pytorch_safetensors(t3_path)
        t3_converted = convert_t3_weights(t3_weights)
        for k, v in t3_converted.items():
            all_weights[f"t3.{k}"] = v
        print(f"  Converted {len(t3_weights)} -> {len(t3_converted)} T3 weights")
    else:
        print(f"  WARNING: {t3_path} not found")
    
    # Convert S3Gen
    print("\nConverting S3Gen...")
    s3gen_path = ckpt_dir / "s3gen_meanflow.safetensors"
    if not s3gen_path.exists():
        s3gen_path = ckpt_dir / "s3gen.safetensors"
    
    if s3gen_path.exists():
        s3gen_weights = load_pytorch_safetensors(s3gen_path)
        
        # Convert to MLX arrays for sanitize
        def numpy_to_mlx(weights):
            return {k: mx.array(v) for k, v in weights.items()}
        
        s3gen_weights_mx = numpy_to_mlx(s3gen_weights)
        
        # Use S3Gen sanitize
        s3gen = S3Gen(meanflow=True)
        if hasattr(s3gen, 'sanitize'):
            s3gen_weights_mx = s3gen.sanitize(s3gen_weights_mx)
        
        # Convert back to numpy
        for k, v in s3gen_weights_mx.items():
            all_weights[f"s3gen.{k}"] = np.array(v)
        print(f"  Converted {len(s3gen_weights)} S3Gen weights (after sanitize: {len(s3gen_weights_mx)})")
    else:
        print(f"  WARNING: {s3gen_path} not found")
    
    # Save combined model weights
    print("\nSaving model.safetensors...")
    save_mlx_safetensors(all_weights, output_dir / "model.safetensors")
    
    # Convert conds.pt to conds.safetensors
    print("\nConverting conditionals...")
    conds_path = ckpt_dir / "conds.pt"
    if conds_path.exists():
        conds_weights = load_pytorch_conds(conds_path)
        save_mlx_safetensors(conds_weights, output_dir / "conds.safetensors")
    else:
        print(f"  WARNING: {conds_path} not found - model won't have built-in voice!")
    
    # Copy tokenizer files
    print("\nCopying tokenizer files...")
    for fname in ["tokenizer.json", "vocab.json", "merges.txt", "tokenizer_config.json", 
                  "added_tokens.json", "special_tokens_map.json"]:
        src = ckpt_dir / fname
        if src.exists():
            shutil.copy(src, output_dir / fname)
            print(f"  Copied {fname}")
    
    # Create config.json
    print("\nCreating config.json...")
    config = {
        "model_type": "chatterbox_turbo",
        "version": "1.0",
        "sample_rate": 24000,
    }
    with open(output_dir / "config.json", "w") as f:
        json.dump(config, f, indent=2)
    
    # Create README
    readme = """# Chatterbox Turbo - MLX Converted

This model was converted from [ResembleAI/chatterbox-turbo](https://huggingface.co/ResembleAI/chatterbox-turbo) to MLX format.

## Usage

```python
from mlx_audio.tts.models.chatterbox_turbo import ChatterboxTurboTTS

model = ChatterboxTurboTTS.from_local("./Chatterbox-Turbo-converted")
audio = list(model.generate("Hello, this is a test."))
```
"""
    with open(output_dir / "README.md", "w") as f:
        f.write(readme)
    
    print(f"\n✅ Conversion complete! Output directory: {output_dir}")
    print(f"\nTotal model weights: {len(all_weights)}")
    print("\nFiles created:")
    for f in sorted(output_dir.iterdir()):
        size_mb = f.stat().st_size / (1024 * 1024)
        print(f"  {f.name}: {size_mb:.1f} MB")


def main():
    parser = argparse.ArgumentParser(description="Convert Chatterbox Turbo to MLX")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("./Chatterbox-Turbo-converted"),
        help="Output directory for converted model",
    )
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=None,
        help="Cache directory for downloads",
    )
    args = parser.parse_args()
    
    convert_turbo(args.output, args.cache_dir)


if __name__ == "__main__":
    main()
