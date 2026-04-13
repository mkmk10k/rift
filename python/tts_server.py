#!/opt/homebrew/bin/python3.11
"""
Persistent TTS Server - Keeps model loaded in memory for fast synthesis
Supports streaming mode for long texts
Communicates via stdin/stdout JSON messages

Supports multiple TTS backends:
- Kokoro (default, stable): Fast, low-memory, 4 preset voices
- Chatterbox Turbo (beta): ~20 preset voices, expression tags, higher memory usage
"""

import sys
import json
import os
import re
import gc
import platform
import subprocess
from pathlib import Path

# psutil is imported after ensure_package call below

# Early logging for debugging startup issues
sys.stderr.write("[TTS Server] Starting Python script...\n")
sys.stderr.flush()

# Check for Apple Silicon - MLX only works on arm64
if platform.machine() != 'arm64':
    print(json.dumps({
        "type": "error", 
        "error": "VoiceFlow requires Apple Silicon (M1/M2/M3/M4). Intel Macs are not supported for local TTS."
    }), flush=True)
    sys.exit(1)

sys.stderr.write("[TTS Server] Apple Silicon detected, checking dependencies...\n")
sys.stderr.flush()


def ensure_package(package_name, import_name=None):
    """Try to import a package, install if missing.
    
    Args:
        package_name: The pip package name to install
        import_name: The Python import name (if different from package_name)
    """
    check_name = import_name or package_name
    try:
        __import__(check_name)
        return True
    except ImportError:
        sys.stderr.write(f"[TTS Server] Installing missing package: {package_name}...\n")
        sys.stderr.flush()
        try:
            # Show output for debugging - some packages take time to install
            result = subprocess.run(
                [sys.executable, '-m', 'pip', 'install', package_name],
                capture_output=True,
                text=True,
                timeout=300  # 5 minute timeout for large packages
            )
            if result.returncode == 0:
                sys.stderr.write(f"[TTS Server] {package_name} installed successfully\n")
                sys.stderr.flush()
                return True
            else:
                sys.stderr.write(f"[TTS Server] pip install failed: {result.stderr[:500]}\n")
                sys.stderr.flush()
                return False
        except subprocess.TimeoutExpired:
            sys.stderr.write(f"[TTS Server] Timeout installing {package_name}\n")
            sys.stderr.flush()
            return False
        except Exception as e:
            sys.stderr.write(f"[TTS Server] Failed to install {package_name}: {e}\n")
            sys.stderr.flush()
            return False


# Ensure psutil is installed for memory monitoring
ensure_package('psutil')
import psutil

# Ensure mlx_audio TTS dependencies are installed
# The cleanest approach is to ensure mlx_audio's TTS extras are properly installed
# rather than trying to track individual transitive dependencies

def ensure_mlx_audio_tts():
    """Ensure mlx_audio with TTS support is properly installed."""
    try:
        # Test if we can import the TTS pipeline
        from mlx_audio.tts.models.kokoro import KokoroPipeline
        sys.stderr.write("[TTS Server] mlx_audio TTS already configured\n")
        sys.stderr.flush()
        return True
    except ImportError as e:
        error_msg = str(e)
        sys.stderr.write(f"[TTS Server] mlx_audio TTS import failed: {error_msg}\n")
        sys.stderr.flush()
        
        # Check if it's a missing module
        if "No module named" in error_msg:
            missing_module = error_msg.split("'")[1] if "'" in error_msg else "unknown"
            sys.stderr.write(f"[TTS Server] Missing module: {missing_module}\n")
            sys.stderr.flush()
            
            # Try to install the missing dependency
            try:
                sys.stderr.write(f"[TTS Server] Installing {missing_module}...\n")
                sys.stderr.flush()
                result = subprocess.run(
                    [sys.executable, '-m', 'pip', 'install', missing_module],
                    capture_output=True, text=True, timeout=300
                )
                if result.returncode == 0:
                    sys.stderr.write(f"[TTS Server] {missing_module} installed\n")
                    sys.stderr.flush()
                    return False  # Need to restart to pick up new module
                else:
                    sys.stderr.write(f"[TTS Server] pip install failed: {result.stderr[:200]}\n")
                    sys.stderr.flush()
            except Exception as install_err:
                sys.stderr.write(f"[TTS Server] Install error: {install_err}\n")
                sys.stderr.flush()
        
        return False
    except Exception as e:
        sys.stderr.write(f"[TTS Server] Unexpected TTS check error: {type(e).__name__}: {e}\n")
        sys.stderr.flush()
        return False

# First, ensure basic dependencies that we know are needed
REQUIRED_PACKAGES = [
    ('loguru', None),           # Logging
    ('soundfile', None),        # Audio I/O
    ('numpy', None),            # Numerical operations  
    ('munch', None),            # Config dict handling
]

sys.stderr.write(f"[TTS Server] Checking {len(REQUIRED_PACKAGES)} core packages...\n")
sys.stderr.flush()

for pkg_info in REQUIRED_PACKAGES:
    if isinstance(pkg_info, tuple):
        pkg_name, import_name = pkg_info
    else:
        pkg_name, import_name = pkg_info, None
    ensure_package(pkg_name, import_name)

# Monkey-patch phonemizer's EspeakWrapper to add set_data_path method
# This is required by misaki but missing from standard phonemizer
sys.stderr.write("[TTS Server] Patching phonemizer for misaki compatibility...\n")
sys.stderr.flush()
try:
    from phonemizer.backend.espeak.wrapper import EspeakWrapper
    
    # Add the missing set_data_path class method if it doesn't exist
    if not hasattr(EspeakWrapper, 'set_data_path'):
        # Store the data path in a class variable
        EspeakWrapper._ESPEAK_DATA_PATH = None
        
        @classmethod
        def _set_data_path(cls, path):
            """Set the espeak-ng data path (added by monkey-patch for misaki compatibility)"""
            cls._ESPEAK_DATA_PATH = path
            # Also set the environment variable that espeak-ng uses
            os.environ['ESPEAK_DATA_PATH'] = path
        
        EspeakWrapper.set_data_path = _set_data_path
        sys.stderr.write("[TTS Server] Added set_data_path method to EspeakWrapper\n")
        sys.stderr.flush()
    else:
        sys.stderr.write("[TTS Server] EspeakWrapper already has set_data_path\n")
        sys.stderr.flush()
except ImportError as e:
    sys.stderr.write(f"[TTS Server] Could not patch phonemizer: {e}\n")
    sys.stderr.flush()
except Exception as e:
    sys.stderr.write(f"[TTS Server] Patch error: {e}\n")
    sys.stderr.flush()

# Check if real PyTorch is available (needed for chatterbox-mlx)
# If real torch is available, use it; otherwise create a mock for mlx_audio compatibility
_has_real_torch = False
try:
    # Try to import real torch
    import torch as _real_torch
    if hasattr(_real_torch, 'cuda') or hasattr(_real_torch, 'mps'):
        _has_real_torch = True
        sys.stderr.write("[TTS Server] Real PyTorch detected, skipping mock\n")
        sys.stderr.flush()
except ImportError:
    pass

if not _has_real_torch:
    # Create a mock torch module for loading .pt files without PyTorch
    # The mlx_audio voice loader tries to unpickle PyTorch files which reference torch classes
    sys.stderr.write("[TTS Server] Creating mock torch module for .pt loading...\n")
    sys.stderr.flush()
    try:
        import types
        from importlib.machinery import ModuleSpec
        from importlib.abc import MetaPathFinder, Loader
        
        # Create a meta path finder to intercept ALL torch.* imports
        class TorchMockFinder(MetaPathFinder):
            """Import hook that intercepts all torch.* module imports."""
            
            def find_spec(self, fullname, path, target=None):
                if fullname == 'torch' or fullname.startswith('torch.'):
                    return ModuleSpec(fullname, TorchMockLoader(), is_package=True)
                return None
        
        class TorchMockLoader(Loader):
            """Loader that creates mock modules for any torch.* import."""
            
            def create_module(self, spec):
                # Return None to use default module creation
                return None
            
            def exec_module(self, module):
                # Configure the module as a package
                module.__path__ = []
                module.__package__ = module.__name__
                # Make it callable
                module.__class__ = CallableMockModule
        
        class MockObject:
            """A mock object that returns itself for any attribute/call."""
            def __init__(self, name='mock'):
                self._name = name
            def __getattr__(self, name):
                if name.startswith('_'):
                    return object.__getattribute__(self, name) if name in self.__dict__ else MockObject(f"{self._name}.{name}")
                return MockObject(f"{self._name}.{name}")
            def __call__(self, *args, **kwargs):
                return MockObject(f"{self._name}()")
            def __bool__(self):
                return True
            def __repr__(self):
                return f"<MockObject '{self._name}'>"
            def __mro_entries__(self, bases):
                # Required for when MockObject is used as a base class (PEP 560)
                return (object,)
        
        class CallableMockModule(types.ModuleType):
            """A module type that's callable and returns mock values for any attribute."""
            
            def __call__(self, *args, **kwargs):
                return MockObject(f"{self.__name__}()")
            
            def __getattr__(self, name):
                # Check if attribute was explicitly set on the module
                try:
                    return object.__getattribute__(self, name)
                except AttributeError:
                    pass
                # Return a mock value for any unknown attribute
                if name.startswith('__'):
                    raise AttributeError(name)
                return MockObject(f"{self.__name__}.{name}")
            
            def __bool__(self):
                return True
        
        # Install the import hook FIRST (before any torch imports happen)
        sys.meta_path.insert(0, TorchMockFinder())
        
        # Now create and configure the main torch module with essential attributes
        import torch  # This will use our mock finder
        
        # Add essential attributes that pickle/unpickle needs
        torch.__version__ = '2.0.0'
        
        # Storage classes with correct __name__ for pickle deserialization
        def make_storage_class(name):
            class Storage:
                def __init__(self, *args, **kwargs):
                    pass
            Storage.__name__ = name
            Storage.__qualname__ = name
            return Storage
        
        for storage_name in ['FloatStorage', 'DoubleStorage', 'HalfStorage',
                             'IntStorage', 'LongStorage', 'ByteStorage',
                             'CharStorage', 'ShortStorage', 'BoolStorage']:
            setattr(torch, storage_name, make_storage_class(storage_name))
        
        # Configure torch.storage
        torch.storage.TypedStorage = make_storage_class('TypedStorage')
        torch.storage._TypedStorage = make_storage_class('_TypedStorage')
        
        # Configure torch._utils
        def _rebuild_tensor_v2(*args, **kwargs):
            pass
        torch._utils._rebuild_tensor_v2 = _rebuild_tensor_v2
        
        # Tensor class
        class MockTensor:
            def __init__(self, *args, **kwargs):
                pass
        torch.Tensor = MockTensor
        
        # nn.Module
        torch.nn.Module = type('Module', (), {'__init__': lambda s, *a, **k: None})
        
        # dtypes
        for dtype_name in ['float32', 'float64', 'float16', 'bfloat16', 'int32', 'int64',
                           'int16', 'int8', 'uint8', 'bool', 'complex64', 'complex128']:
            setattr(torch, dtype_name, dtype_name)
        torch.long = 'int64'
        torch.float = 'float32'
        torch.half = 'float16'
        torch.double = 'float64'
        torch.dtype = type('dtype', (), {})
        
        # Common functions
        torch.no_grad = lambda: type('ctx', (), {'__enter__': lambda s: None, '__exit__': lambda s,*a: None})()
        torch.is_tensor = lambda x: False
        torch.from_numpy = lambda x: x
        torch.tensor = lambda x, **kw: x
        
        sys.stderr.write("[TTS Server] Mock torch module installed\n")
        sys.stderr.flush()
    except Exception as e:
        sys.stderr.write(f"[TTS Server] Mock torch creation error: {e}\n")
        sys.stderr.flush()

# Suppress mlx warnings
os.environ['MLX_DISABLE_METAL_WARNINGS'] = '1'

try:
    sys.stderr.write("[TTS Server] Importing mlx_audio...\n")
    sys.stderr.flush()
    from mlx_audio.tts.models.kokoro import KokoroPipeline
    from mlx_audio.tts.utils import load_model
    sys.stderr.write("[TTS Server] mlx_audio imported successfully\n")
    sys.stderr.flush()
    import soundfile as sf
    import numpy as np
    sys.stderr.write("[TTS Server] All dependencies loaded\n")
    sys.stderr.flush()
except ImportError as e:
    sys.stderr.write(f"[TTS Server] ImportError: {e}\n")
    sys.stderr.flush()
    print(json.dumps({"type": "error", "error": f"Missing dependency: {e}"}), flush=True)
    sys.exit(1)
except Exception as e:
    sys.stderr.write(f"[TTS Server] Unexpected error during import: {type(e).__name__}: {e}\n")
    sys.stderr.flush()
    print(json.dumps({"type": "error", "error": f"Startup error: {type(e).__name__}: {e}"}), flush=True)
    sys.exit(1)

# ═══════════════════════════════════════════════════════════════════════════════
# MULTI-MODEL TTS SUPPORT
# ═══════════════════════════════════════════════════════════════════════════════

# Current TTS backend: "kokoro" | "chatterbox" | "chatterbox-turbo"
CURRENT_MODEL = "kokoro"

# Memory monitoring for Chatterbox (has known memory leak)
BASELINE_MEMORY_MB = None
MEMORY_THRESHOLD_MB = 500  # Restart if memory grows by 500MB

# Kokoro model cache
_kokoro_model = None
_kokoro_pipeline = None
_kokoro_model_id = "prince-canuma/Kokoro-82M"

# Chatterbox model cache
_chatterbox_model = None

# Chatterbox Turbo model cache (uses CPU - MPS has bugs)
_chatterbox_turbo_model = None

# Chatterbox Full MLX model cache (fast, works correctly)
_chatterbox_full_mlx_model = None

# Available voices per model
KOKORO_VOICES = {
    'af_heart': 'Heart',
    'af_bella': 'Bella', 
    'af_sarah': 'Sarah',
    'am_adam': 'Adam',
}

# Chatterbox Turbo preset voices (subset - full list loaded from model)
CHATTERBOX_VOICES = {
    'aaron': 'Aaron',
    'abigail': 'Abigail',
    'anaya': 'Anaya',
    'andy': 'Andy',
    'archer': 'Archer',
    'brian': 'Brian',
    'chloe': 'Chloe',
    'dylan': 'Dylan',
    'evelyn': 'Evelyn',
    'fiona': 'Fiona',
}

# Legacy compatibility
_model = None
_pipeline = None
_model_id = "prince-canuma/Kokoro-82M"


def get_memory_mb() -> float:
    """Get current process memory usage in MB."""
    try:
        process = psutil.Process(os.getpid())
        return process.memory_info().rss / (1024 * 1024)
    except Exception:
        return 0.0


def check_memory_and_signal():
    """Check if memory has grown too much and signal restart if needed (Chatterbox only)."""
    global BASELINE_MEMORY_MB
    
    if CURRENT_MODEL != "chatterbox" or BASELINE_MEMORY_MB is None:
        return
    
    current = get_memory_mb()
    growth = current - BASELINE_MEMORY_MB
    
    if growth > MEMORY_THRESHOLD_MB:
        sys.stderr.write(f"[TTS Server] Memory growth detected: {growth:.0f}MB (threshold: {MEMORY_THRESHOLD_MB}MB)\n")
        sys.stderr.flush()
        print(json.dumps({
            "type": "restart_needed",
            "reason": "memory_optimization",
            "current_mb": current,
            "baseline_mb": BASELINE_MEMORY_MB,
            "growth_mb": growth
        }), flush=True)


def unload_current_model():
    """Unload the current TTS model to free memory."""
    global _kokoro_model, _kokoro_pipeline, _chatterbox_model, _chatterbox_turbo_model, _model, _pipeline
    
    sys.stderr.write(f"[TTS Server] Unloading {CURRENT_MODEL} model...\n")
    sys.stderr.flush()
    
    # Clear Kokoro
    _kokoro_model = None
    _kokoro_pipeline = None
    _model = None
    _pipeline = None
    
    # Clear Chatterbox
    _chatterbox_model = None
    
    # Clear Chatterbox Turbo
    _chatterbox_turbo_model = None
    
    # Clear Chatterbox Full MLX
    _chatterbox_full_mlx_model = None
    
    # Force garbage collection
    gc.collect()
    
    # Clear MLX GPU cache
    try:
        import mlx.core as mx
        mx.metal.clear_cache()
    except Exception:
        pass
    
    # Clear PyTorch MPS cache if available (for Turbo)
    try:
        import torch
        if hasattr(torch, 'mps') and hasattr(torch.mps, 'empty_cache'):
            torch.mps.empty_cache()
    except Exception:
        pass
    
    sys.stderr.write(f"[TTS Server] Model unloaded, memory freed\n")
    sys.stderr.flush()


def initialize_kokoro():
    """Load Kokoro model into memory."""
    global _kokoro_model, _kokoro_pipeline, _model, _pipeline, BASELINE_MEMORY_MB
    
    if _kokoro_model is None:
        sys.stderr.write("[TTS Server] Loading Kokoro model...\n")
        sys.stderr.flush()
        _kokoro_model = load_model(_kokoro_model_id)
        _kokoro_pipeline = KokoroPipeline(lang_code="a", model=_kokoro_model, repo_id=_kokoro_model_id)
        
        # Legacy compatibility
        _model = _kokoro_model
        _pipeline = _kokoro_pipeline
        
        sys.stderr.write("[TTS Server] Kokoro model loaded!\n")
        sys.stderr.flush()
        
        # Signal model is loaded
        print(json.dumps({"type": "model_loaded", "model": "kokoro"}), flush=True)
        
        # Pre-load the default voice
        sys.stderr.write("[TTS Server] Pre-loading voice 'af_heart'...\n")
        sys.stderr.flush()
        _kokoro_pipeline.load_voice("af_heart")
        
        # Warmup synthesis
        sys.stderr.write("[TTS Server] Warming up Neural Engine...\n")
        sys.stderr.flush()
        warmup_text = "Hello, this is a warmup sentence."
        for _ in _kokoro_pipeline(warmup_text, voice="af_heart", speed=1.0, 
                                   split_pattern=r'(?<=[.!?,;:])\s+'):
            pass
        sys.stderr.write("[TTS Server] Kokoro warmup complete!\n")
        sys.stderr.flush()
        
        # Record baseline memory
        BASELINE_MEMORY_MB = get_memory_mb()
    
    return _kokoro_pipeline


def initialize_chatterbox():
    """Load Chatterbox TTS model into memory using chatterbox-mlx package."""
    global _chatterbox_model, BASELINE_MEMORY_MB
    
    if _chatterbox_model is None:
        sys.stderr.write("[TTS Server] Loading Chatterbox TTS model (chatterbox-mlx)...\n")
        sys.stderr.flush()
        
        try:
            # Use the working chatterbox-mlx package (not mlx_audio which produces static)
            from chatterbox import ChatterboxTTS
            
            sys.stderr.write("[TTS Server] Loading ChatterboxTTS with MPS backend...\n")
            sys.stderr.flush()
            
            # Load model with MPS (Metal Performance Shaders) for Apple Silicon
            _chatterbox_model = ChatterboxTTS.from_pretrained(device="mps")
            
            sys.stderr.write("[TTS Server] Chatterbox TTS model loaded!\n")
            sys.stderr.flush()
            
            # Warmup synthesis (model_loaded sent AFTER warmup succeeds)
            sys.stderr.write("[TTS Server] Warming up Chatterbox...\n")
            sys.stderr.flush()
            warmup_text = "Hello, this is a warmup."
            _ = _chatterbox_model.generate(text=warmup_text)
            sys.stderr.write("[TTS Server] Chatterbox warmup complete!\n")
            sys.stderr.flush()
            
            # Signal model is loaded ONLY after warmup succeeds
            print(json.dumps({"type": "model_loaded", "model": "chatterbox"}), flush=True)
            
            # Record baseline memory for leak detection
            BASELINE_MEMORY_MB = get_memory_mb()
            sys.stderr.write(f"[TTS Server] Chatterbox baseline memory: {BASELINE_MEMORY_MB:.0f}MB\n")
            sys.stderr.flush()
            
        except ImportError as e:
            sys.stderr.write(f"[TTS Server] Chatterbox import failed: {e}\n")
            sys.stderr.flush()
            print(json.dumps({"type": "error", "error": f"Chatterbox not available: {e}"}), flush=True)
            return None
        except Exception as e:
            sys.stderr.write(f"[TTS Server] Chatterbox load failed: {e}\n")
            sys.stderr.flush()
            print(json.dumps({"type": "error", "error": f"Failed to load Chatterbox: {e}"}), flush=True)
            return None
    
    return _chatterbox_model


def initialize_chatterbox_turbo():
    """Load Chatterbox Turbo TTS model - MUST USE CPU (MPS has bugs on Apple Silicon)."""
    global _chatterbox_turbo_model, BASELINE_MEMORY_MB
    
    if _chatterbox_turbo_model is None:
        sys.stderr.write("[TTS Server] Loading Chatterbox Turbo TTS model (CPU-only)...\n")
        sys.stderr.flush()
        
        try:
            # Use the official chatterbox-tts package's turbo model
            from chatterbox.tts_turbo import ChatterboxTurboTTS
            
            sys.stderr.write("[TTS Server] Loading ChatterboxTurboTTS with CPU backend (MPS has bugs)...\n")
            sys.stderr.flush()
            
            # CRITICAL: Force CPU - MPS produces broken/low-quality audio on Apple Silicon
            _chatterbox_turbo_model = ChatterboxTurboTTS.from_pretrained(device="cpu")
            
            sys.stderr.write("[TTS Server] Chatterbox Turbo model loaded!\n")
            sys.stderr.flush()
            
            # Warmup synthesis (model_loaded sent AFTER warmup succeeds)
            sys.stderr.write("[TTS Server] Warming up Chatterbox Turbo...\n")
            sys.stderr.flush()
            warmup_text = "Hello, this is a warmup."
            _ = _chatterbox_turbo_model.generate(warmup_text)
            sys.stderr.write("[TTS Server] Chatterbox Turbo warmup complete!\n")
            sys.stderr.flush()
            
            # Signal model is loaded ONLY after warmup succeeds
            print(json.dumps({"type": "model_loaded", "model": "chatterbox-turbo"}), flush=True)
            
            # Record baseline memory for leak detection
            BASELINE_MEMORY_MB = get_memory_mb()
            sys.stderr.write(f"[TTS Server] Chatterbox Turbo baseline memory: {BASELINE_MEMORY_MB:.0f}MB\n")
            sys.stderr.flush()
            
        except ImportError as e:
            sys.stderr.write(f"[TTS Server] Chatterbox Turbo import failed: {e}\n")
            sys.stderr.flush()
            print(json.dumps({"type": "error", "error": f"Chatterbox Turbo not available: {e}"}), flush=True)
            return None
        except Exception as e:
            sys.stderr.write(f"[TTS Server] Chatterbox Turbo load failed: {e}\n")
            sys.stderr.flush()
            print(json.dumps({"type": "error", "error": f"Failed to load Chatterbox Turbo: {e}"}), flush=True)
            return None
    
    return _chatterbox_turbo_model


def initialize_chatterbox_full_mlx():
    """Load Chatterbox Full MLX model - the working fast version!
    
    This uses the Full Chatterbox model converted to MLX, which produces
    high-quality speech at faster-than-realtime speed on Apple Silicon.
    
    Key fix: mlx_audio has a bug where from_pretrained doesn't call post_load_hook,
    so we must call it manually to load the pre-computed voice conditionals.
    """
    global _chatterbox_full_mlx_model, BASELINE_MEMORY_MB
    
    if _chatterbox_full_mlx_model is None:
        sys.stderr.write("[TTS Server] Loading Chatterbox Full MLX model...\n")
        sys.stderr.flush()
        
        try:
            from mlx_audio.tts.models.chatterbox import Model as ChatterboxFull
            from pathlib import Path
            
            # Model path - use the bundled model with pre-computed conditionals
            script_dir = Path(__file__).parent.parent
            model_path = script_dir / "models" / "chatterbox-full-mlx"
            
            if not model_path.exists():
                # Fallback to HuggingFace download
                sys.stderr.write("[TTS Server] Local model not found, downloading from HuggingFace...\n")
                sys.stderr.flush()
                model_path = "mlx-community/Chatterbox-TTS-fp16"
            
            sys.stderr.write(f"[TTS Server] Loading model from: {model_path}\n")
            sys.stderr.flush()
            
            _chatterbox_full_mlx_model = ChatterboxFull.from_pretrained(str(model_path))
            
            # BUG FIX: mlx_audio doesn't call post_load_hook in from_pretrained,
            # so conditionals don't get loaded. We must call it manually.
            if isinstance(model_path, Path) and model_path.exists():
                sys.stderr.write("[TTS Server] Loading conditionals (bug fix for mlx_audio)...\n")
                sys.stderr.flush()
                _chatterbox_full_mlx_model = ChatterboxFull.post_load_hook(
                    _chatterbox_full_mlx_model, model_path
                )
            
            # Check if conditionals are loaded
            if _chatterbox_full_mlx_model._conds is None:
                sys.stderr.write("[TTS Server] WARNING: Conditionals not loaded - will need audio_prompt\n")
                sys.stderr.flush()
            else:
                sys.stderr.write("[TTS Server] Conditionals loaded successfully!\n")
                sys.stderr.flush()
            
            sys.stderr.write("[TTS Server] Chatterbox Full MLX model loaded!\n")
            sys.stderr.flush()
            
            # Warmup synthesis
            sys.stderr.write("[TTS Server] Warming up Chatterbox Full MLX...\n")
            sys.stderr.flush()
            warmup_text = "Hello, this is a warmup."
            _ = list(_chatterbox_full_mlx_model.generate(warmup_text))
            sys.stderr.write("[TTS Server] Chatterbox Full MLX warmup complete!\n")
            sys.stderr.flush()
            
            # Signal model is loaded
            print(json.dumps({"type": "model_loaded", "model": "chatterbox-full-mlx"}), flush=True)
            
            # Record baseline memory
            BASELINE_MEMORY_MB = get_memory_mb()
            sys.stderr.write(f"[TTS Server] Chatterbox Full MLX baseline memory: {BASELINE_MEMORY_MB:.0f}MB\n")
            sys.stderr.flush()
            
        except ImportError as e:
            sys.stderr.write(f"[TTS Server] Chatterbox Full MLX import failed: {e}\n")
            sys.stderr.flush()
            print(json.dumps({"type": "error", "error": f"Chatterbox Full MLX not available: {e}"}), flush=True)
            return None
        except Exception as e:
            sys.stderr.write(f"[TTS Server] Chatterbox Full MLX load failed: {e}\n")
            sys.stderr.flush()
            import traceback
            traceback.print_exc(file=sys.stderr)
            print(json.dumps({"type": "error", "error": f"Failed to load Chatterbox Full MLX: {e}"}), flush=True)
            return None
    
    return _chatterbox_full_mlx_model


def initialize_model():
    """Load model into memory - only done once (legacy compatibility)"""
    global _model, _pipeline
    
    if CURRENT_MODEL == "chatterbox":
        model = initialize_chatterbox()
        if model is None:
            # Fallback to Kokoro if Chatterbox fails
            sys.stderr.write("[TTS Server] Falling back to Kokoro...\n")
            sys.stderr.flush()
            return initialize_kokoro()
        return model
    elif CURRENT_MODEL == "chatterbox-turbo":
        model = initialize_chatterbox_turbo()
        if model is None:
            # Fallback to Kokoro if Chatterbox Turbo fails
            sys.stderr.write("[TTS Server] Falling back to Kokoro...\n")
            sys.stderr.flush()
            return initialize_kokoro()
        return model
    elif CURRENT_MODEL == "chatterbox-full-mlx":
        model = initialize_chatterbox_full_mlx()
        if model is None:
            # Fallback to Kokoro if Chatterbox Full MLX fails
            sys.stderr.write("[TTS Server] Falling back to Kokoro...\n")
            sys.stderr.flush()
            return initialize_kokoro()
        return model
    else:
        return initialize_kokoro()


def transform_to_natural_speech(text: str) -> str:
    """
    Transform structured text (markdown-like) into natural speech.
    Preserves meaning while making it sound like a human reading aloud.
    """
    lines = text.split('\n')
    result_parts = []
    
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        
        if not line:
            # Empty line = paragraph break, add pause
            if result_parts and not result_parts[-1].endswith('...'):
                result_parts.append('...')
            i += 1
            continue
        
        # Detect markdown headings (# Heading or ## Heading)
        heading_match = re.match(r'^#{1,3}\s+(.+)$', line)
        if heading_match:
            heading_text = heading_match.group(1).strip()
            # Add pause before heading if not first
            if result_parts:
                result_parts.append('...')
            result_parts.append(heading_text + '.')
            result_parts.append('...')
            i += 1
            continue
        
        # Detect if line looks like a heading (short, followed by content)
        is_likely_heading = (
            len(line) < 50 and 
            not line.endswith('.') and 
            not line.startswith(('-', '*', '•', '1', '2', '3')) and
            i + 1 < len(lines) and 
            lines[i + 1].strip()
        )
        
        if is_likely_heading:
            if result_parts:
                result_parts.append('...')
            result_parts.append(line + '.')
            result_parts.append('...')
            i += 1
            continue
        
        # Detect bullet points or numbered lists
        bullet_match = re.match(r'^[\-\*•]\s+(.+)$', line)
        number_match = re.match(r'^(\d+)[\.\)]\s+(.+)$', line)
        
        if bullet_match:
            content = bullet_match.group(1).strip()
            # Check if this is the first bullet in a series
            prev_was_bullet = i > 0 and re.match(r'^[\-\*•]\s+', lines[i-1].strip())
            if not prev_was_bullet and result_parts:
                result_parts.append('...')
            # Add the bullet content with natural pacing
            if not content.endswith(('.', '!', '?')):
                content += '.'
            result_parts.append(content)
            i += 1
            continue
        
        if number_match:
            num = number_match.group(1)
            content = number_match.group(2).strip()
            # Check if first numbered item
            prev_was_numbered = i > 0 and re.match(r'^\d+[\.\)]', lines[i-1].strip())
            if not prev_was_numbered and result_parts:
                result_parts.append('...')
            # Natural reading: "First, ..." or "Number one, ..."
            ordinals = {
                '1': 'First', '2': 'Second', '3': 'Third', '4': 'Fourth', 
                '5': 'Fifth', '6': 'Sixth', '7': 'Seventh', '8': 'Eighth'
            }
            prefix = ordinals.get(num, f'Number {num}')
            if not content.endswith(('.', '!', '?')):
                content += '.'
            result_parts.append(f'{prefix}, {content}')
            i += 1
            continue
        
        # Regular text - just add it
        result_parts.append(line)
        i += 1
    
    # Join and clean up
    result = ' '.join(result_parts)
    
    # Clean up multiple pauses
    result = re.sub(r'\.{3,}', '...', result)
    result = re.sub(r'\.\s*\.\.\.', '...', result)
    result = re.sub(r'\.\.\.(\s*\.\.\.)+', '...', result)
    
    # Clean up spacing
    result = re.sub(r'\s+', ' ', result)
    result = result.strip()
    
    return result


def sanitize_for_tts(text: str) -> str:
    """Final cleanup for TTS - handle special characters"""
    # Replace unicode with speakable equivalents
    replacements = {
        '→': 'leads to',
        '←': 'comes from', 
        '↔': 'goes both ways',
        '•': '',  # Handled in structure parsing
        '–': '-',
        '—': ', ',
        '"': '"',
        '"': '"',
        ''': "'",
        ''': "'",
        '`': '',
        '**': '',
        '*': '',
        '_': '',
        '#': '',
        '```': '',
        '\\n': ' ',
        '\\t': ' ',
        '<': 'less than',
        '>': 'greater than',
        '&': 'and',
        '@': 'at',
        '%': 'percent',
        '$': 'dollars',
        '€': 'euros',
        '£': 'pounds',
    }
    
    for old, new in replacements.items():
        text = text.replace(old, new)
    
    # Remove any remaining non-printable characters except basic punctuation
    text = ''.join(char for char in text if char.isprintable() or char == ' ')
    
    # Clean up spacing
    text = re.sub(r'\s+', ' ', text)
    
    return text.strip()


def split_into_chunks(text: str, max_chars: int = 400) -> list:
    """
    Split text into natural speech chunks.
    Preserves semantic structure while ensuring chunks are speakable.
    """
    # First transform to natural speech (handles structure)
    text = transform_to_natural_speech(text)
    
    # Then sanitize for TTS
    text = sanitize_for_tts(text)
    
    if not text:
        return []
    
    sys.stderr.write(f"[TTS Server] Transformed text ({len(text)} chars): {text[:100]}...\n")
    sys.stderr.flush()
    
    # If text is short enough, return as single chunk
    if len(text) <= max_chars:
        return [text]
    
    # Try to split at natural pause points (...)
    # This preserves the semantic chunks we created
    pause_chunks = text.split('...')
    
    chunks = []
    current_chunk = ""
    
    for part in pause_chunks:
        part = part.strip()
        if not part:
            continue
            
        # If this part fits in current chunk, add it
        if len(current_chunk) + len(part) + 4 <= max_chars:  # +4 for "... "
            if current_chunk:
                current_chunk += "... " + part
            else:
                current_chunk = part
        else:
            # Save current chunk and start new one
            if current_chunk:
                chunks.append(current_chunk)
            
            # If this single part is too long, split by sentences
            if len(part) > max_chars:
                sentences = re.split(r'(?<=[.!?])\s+', part)
                sub_chunk = ""
                for sentence in sentences:
                    if len(sub_chunk) + len(sentence) + 1 <= max_chars:
                        sub_chunk += sentence + " "
                    else:
                        if sub_chunk.strip():
                            chunks.append(sub_chunk.strip())
                        sub_chunk = sentence + " "
                if sub_chunk.strip():
                    current_chunk = sub_chunk.strip()
                else:
                    current_chunk = ""
            else:
                current_chunk = part
    
    # Don't forget the last chunk
    if current_chunk.strip():
        chunks.append(current_chunk.strip())
    
    # Filter and clean
    chunks = [c.strip() for c in chunks if c and c.strip()]
    
    sys.stderr.write(f"[TTS Server] Split into {len(chunks)} natural chunks\n")
    for i, c in enumerate(chunks):
        sys.stderr.write(f"[TTS Server]   Chunk {i+1}: {c[:60]}...\n")
    sys.stderr.flush()
    
    return chunks if chunks else [text]


def synthesize(text: str, voice: str = "af_heart", speed: float = 1.0, output_file: str = None) -> dict:
    """Synthesize speech - routes to appropriate backend based on CURRENT_MODEL."""
    if CURRENT_MODEL == "chatterbox":
        return synthesize_with_chatterbox(text, voice, speed, output_file)
    elif CURRENT_MODEL == "chatterbox-turbo":
        return synthesize_with_chatterbox_turbo(text, voice, speed, output_file)
    elif CURRENT_MODEL == "chatterbox-full-mlx":
        # Use realtime mode for Full MLX (no separate single-chunk mode yet)
        return {"type": "error", "error": "Use realtime synthesis for chatterbox-full-mlx"}
    return synthesize_with_kokoro(text, voice, speed, output_file)


def synthesize_with_kokoro(text: str, voice: str = "af_heart", speed: float = 1.0, output_file: str = None) -> dict:
    """Synthesize speech using Kokoro - single chunk mode with full text transformation"""
    try:
        pipeline = initialize_kokoro()
        sample_rate = 24000
        
        # Apply the same text transformations as streaming mode
        # This ensures paragraph breaks and special formatting work correctly
        processed_text = transform_to_natural_speech(text)
        processed_text = sanitize_for_tts(processed_text)
        
        sys.stderr.write(f"[TTS Server] Synthesizing: {processed_text[:100]}...\n")
        sys.stderr.flush()
        
        # Collect all audio chunks
        all_audio = []
        
        for _, _, audio in pipeline(processed_text, voice=voice, speed=speed, split_pattern=r'\.\.\.'):
            if audio is not None and len(audio) > 0:
                all_audio.append(audio[0])
        
        if not all_audio:
            return {"type": "error", "error": "No audio generated"}
        
        # Concatenate all audio chunks
        combined_audio = np.concatenate(all_audio)
        
        # Save to file
        if output_file:
            output_path = Path(output_file)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            sf.write(str(output_path), combined_audio, sample_rate)
        
        return {
            "type": "success",
            "output_file": output_file,
            "sample_rate": sample_rate,
            "duration": len(combined_audio) / sample_rate
        }
        
    except Exception as e:
        sys.stderr.write(f"[TTS Server] Synthesis error: {str(e)}\n")
        sys.stderr.flush()
        return {"type": "error", "error": f"Synthesis failed: {str(e)}"}


def get_first_segment(text: str, max_chars: int = 25) -> tuple:
    """
    Extract a short first segment for fast initial audio delivery.
    
    Returns (first_segment, remaining_text) where first_segment is guaranteed
    to be short enough for fast synthesis (~150ms instead of 500ms+).
    
    Strategy:
    1. If punctuation (.!?,;:) appears within max_chars, split there
    2. Otherwise, split at the last word boundary before max_chars
    3. If text is already short, return (None, text) - no split needed
    """
    if len(text) <= max_chars:
        return None, text
    
    # Look for natural break point within max_chars
    for i, char in enumerate(text[:max_chars]):
        if char in '.!?,;:':
            # Include the punctuation in first segment
            first = text[:i+1].strip()
            rest = text[i+1:].strip()
            if first:  # Ensure we got something
                return first, rest
    
    # No punctuation found - split at last word boundary before max_chars
    space_idx = text.rfind(' ', 0, max_chars)
    if space_idx > 10:  # Found reasonable word boundary (at least 10 chars)
        first = text[:space_idx].strip()
        rest = text[space_idx:].strip()
        return first, rest
    
    # Text has no spaces in first max_chars - just take the whole first "word"
    # This is rare but handles edge cases
    return None, text


def sanitize_minimal(text: str) -> str:
    """
    Minimal sanitization for realtime TTS - only remove truly problematic characters.
    Preserves most formatting for natural speech flow.
    """
    # Only replace characters that could break TTS or sound unnatural
    replacements = {
        '```': ' code block ',  # Code blocks
        '`': '',                # Inline code markers
        '**': '',               # Bold markers
        '__': '',               # Underline/bold
        '\\n': ' ',             # Escaped newlines
        '\\t': ' ',             # Escaped tabs
        '\t': ' ',              # Tabs
    }
    
    for old, new in replacements.items():
        text = text.replace(old, new)
    
    # Convert newlines to spaces (Kokoro will handle sentence boundaries via split_pattern)
    text = re.sub(r'\n+', ' ', text)
    
    # Collapse multiple spaces
    text = re.sub(r'\s+', ' ', text)
    
    # Remove any non-printable characters
    text = ''.join(char for char in text if char.isprintable() or char == ' ')
    
    return text.strip()


def synthesize_realtime(text: str, voice: str = "af_heart", speed: float = 1.0, 
                        request_id: str = "0"):
    """
    True realtime streaming TTS - routes to appropriate backend based on CURRENT_MODEL.
    """
    if CURRENT_MODEL == "chatterbox":
        yield from synthesize_realtime_chatterbox(text, voice, speed, request_id)
        return
    elif CURRENT_MODEL == "chatterbox-turbo":
        yield from synthesize_realtime_chatterbox_turbo(text, voice, speed, request_id)
        return
    elif CURRENT_MODEL == "chatterbox-full-mlx":
        yield from synthesize_realtime_chatterbox_full_mlx(text, voice, speed, request_id)
        return
    yield from synthesize_realtime_kokoro(text, voice, speed, request_id)


def synthesize_realtime_kokoro(text: str, voice: str = "af_heart", speed: float = 1.0, 
                                request_id: str = "0"):
    """
    True realtime streaming TTS using Kokoro - yields audio segments as they're generated.
    
    Uses Kokoro's native generator with sentence-level splitting for minimal latency.
    Audio is base64 encoded and sent directly (no file I/O).
    """
    import base64
    import io
    
    try:
        pipeline = initialize_kokoro()
        sample_rate = 24000
        
        # Minimal sanitization - preserve natural flow
        processed_text = sanitize_minimal(text)
        
        if not processed_text or not processed_text.strip():
            yield {"type": "error", "request_id": request_id, "error": "No text to synthesize"}
            return
        
        sys.stderr.write(f"[TTS Realtime] Starting: '{processed_text[:80]}...'\n")
        sys.stderr.flush()
        
        chunk_index = 0
        total_duration = 0.0
        
        # FIRST-CHUNK FAST-PATH: Extract short first segment for instant audio
        # This guarantees ~150ms first-word latency regardless of text content
        first_segment, remaining_text = get_first_segment(processed_text, max_chars=25)
        
        if first_segment:
            sys.stderr.write(f"[TTS Realtime] Fast-path first segment: '{first_segment[:40]}'\n")
            sys.stderr.flush()
            
            # Synthesize first segment immediately (no split_pattern - it's already short)
            for graphemes, phonemes, audio in pipeline(first_segment, voice=voice, speed=speed):
                if audio is None or len(audio) == 0:
                    continue
                
                audio_data = audio[0]
                duration = len(audio_data) / sample_rate
                total_duration += duration
                
                wav_buffer = io.BytesIO()
                sf.write(wav_buffer, audio_data, sample_rate, format='WAV')
                wav_bytes = wav_buffer.getvalue()
                audio_base64 = base64.b64encode(wav_bytes).decode('utf-8')
                
                sys.stderr.write(f"[TTS Realtime] Chunk {chunk_index} (fast-path): {len(audio_data)} samples ({duration:.2f}s)\n")
                sys.stderr.flush()
                
                yield {
                    "type": "realtime_chunk",
                    "request_id": request_id,
                    "chunk_index": chunk_index,
                    "audio_base64": audio_base64,
                    "sample_rate": sample_rate,
                    "duration": duration,
                    "text_hint": graphemes[:30] if graphemes else ""
                }
                chunk_index += 1
            
            # Continue with remaining text using clause-based splitting
            if remaining_text:
                for graphemes, phonemes, audio in pipeline(
                    remaining_text, 
                    voice=voice, 
                    speed=speed, 
                    split_pattern=r'(?<=[.!?,;:])\s+'
                ):
                    if audio is None or len(audio) == 0:
                        continue
                    
                    audio_data = audio[0]
                    duration = len(audio_data) / sample_rate
                    total_duration += duration
                    
                    wav_buffer = io.BytesIO()
                    sf.write(wav_buffer, audio_data, sample_rate, format='WAV')
                    wav_bytes = wav_buffer.getvalue()
                    audio_base64 = base64.b64encode(wav_bytes).decode('utf-8')
                    
                    sys.stderr.write(f"[TTS Realtime] Chunk {chunk_index}: {len(audio_data)} samples ({duration:.2f}s)\n")
                    sys.stderr.flush()
                    
                    yield {
                        "type": "realtime_chunk",
                        "request_id": request_id,
                        "chunk_index": chunk_index,
                        "audio_base64": audio_base64,
                        "sample_rate": sample_rate,
                        "duration": duration,
                        "text_hint": graphemes[:30] if graphemes else ""
                    }
                    chunk_index += 1
        else:
            # Text is short enough - use original single-pass approach
            for graphemes, phonemes, audio in pipeline(
                processed_text, 
                voice=voice, 
                speed=speed, 
                split_pattern=r'(?<=[.!?,;:])\s+'  # Split on clause boundaries
            ):
                if audio is None or len(audio) == 0:
                    continue
                
                audio_data = audio[0]  # Get the numpy array
                duration = len(audio_data) / sample_rate
                total_duration += duration
                
                # Convert to WAV in memory and base64 encode
                wav_buffer = io.BytesIO()
                sf.write(wav_buffer, audio_data, sample_rate, format='WAV')
                wav_bytes = wav_buffer.getvalue()
                audio_base64 = base64.b64encode(wav_bytes).decode('utf-8')
                
                sys.stderr.write(f"[TTS Realtime] Chunk {chunk_index}: {len(audio_data)} samples ({duration:.2f}s)\n")
                sys.stderr.flush()
                
                # Yield immediately - no file I/O!
                yield {
                    "type": "realtime_chunk",
                    "request_id": request_id,
                    "chunk_index": chunk_index,
                    "audio_base64": audio_base64,
                    "sample_rate": sample_rate,
                    "duration": duration,
                    "text_hint": graphemes[:30] if graphemes else ""
                }
                
                chunk_index += 1
        
        # Signal completion
        yield {
            "type": "realtime_complete",
            "request_id": request_id,
            "total_chunks": chunk_index,
            "total_duration": total_duration
        }
        
        sys.stderr.write(f"[TTS Realtime] Complete: {chunk_index} chunks, {total_duration:.2f}s total\n")
        sys.stderr.flush()
        
    except Exception as e:
        sys.stderr.write(f"[TTS Realtime] Error: {e}\n")
        sys.stderr.flush()
        yield {"type": "error", "request_id": request_id, "error": f"Realtime synthesis failed: {str(e)}"}


def synthesize_streaming(text: str, voice: str = "af_heart", speed: float = 1.0, 
                         output_dir: str = "/tmp", request_id: str = "0"):
    """Synthesize speech in streaming mode - yields chunks as they're generated (legacy, Kokoro only)"""
    try:
        pipeline = initialize_kokoro()
        sample_rate = 24000
        
        # Split text into manageable chunks (includes sanitization)
        chunks = split_into_chunks(text)
        total_chunks = len(chunks)
        
        if total_chunks == 0:
            yield {"type": "error", "request_id": request_id, "error": "No text to synthesize after sanitization"}
            return
        
        sys.stderr.write(f"[TTS Server] Streaming {total_chunks} chunks\n")
        sys.stderr.flush()
        
        successful_chunks = 0
        
        for i, chunk_text in enumerate(chunks):
            try:
                # Skip empty chunks
                if not chunk_text or not chunk_text.strip():
                    sys.stderr.write(f"[TTS Server] Skipping empty chunk {i}\n")
                    continue
                
                sys.stderr.write(f"[TTS Server] Generating chunk {i+1}/{total_chunks}: '{chunk_text[:30]}...'\n")
                sys.stderr.flush()
                
                # Generate audio for this chunk
                audio_data = None
                
                for _, _, audio in pipeline(chunk_text, voice=voice, speed=speed, split_pattern=r'\n+'):
                    audio_data = audio
                    break
                
                if audio_data is None:
                    sys.stderr.write(f"[TTS Server] Warning: No audio generated for chunk {i}\n")
                    continue
                
                # Save chunk to file
                output_file = f"{output_dir}/tts_stream_{request_id}_{i}.wav"
                output_path = Path(output_file)
                output_path.parent.mkdir(parents=True, exist_ok=True)
                sf.write(str(output_path), audio_data[0], sample_rate)
                
                successful_chunks += 1
                
                # Yield chunk info
                yield {
                    "type": "chunk",
                    "request_id": request_id,
                    "chunk_index": successful_chunks - 1,  # Use successful count for index
                    "total_chunks": total_chunks,
                    "output_file": output_file,
                    "sample_rate": sample_rate,
                    "duration": len(audio_data[0]) / sample_rate,
                    "text": chunk_text[:50] + "..." if len(chunk_text) > 50 else chunk_text
                }
                
            except Exception as chunk_error:
                sys.stderr.write(f"[TTS Server] Error on chunk {i}: {chunk_error}\n")
                sys.stderr.flush()
                # Continue with next chunk instead of failing completely
                continue
        
        # Signal completion
        yield {
            "type": "stream_complete",
            "request_id": request_id,
            "total_chunks": successful_chunks
        }
        
    except Exception as e:
        sys.stderr.write(f"[TTS Server] Streaming failed: {e}\n")
        sys.stderr.flush()
        yield {"type": "error", "request_id": request_id, "error": f"Streaming synthesis failed: {str(e)}"}


def handle_switch_model(new_model: str) -> dict:
    """Switch to a different TTS model."""
    global CURRENT_MODEL, BASELINE_MEMORY_MB
    
    if new_model not in ("kokoro", "chatterbox", "chatterbox-turbo", "chatterbox-full-mlx"):
        return {"type": "error", "error": f"Unknown model: {new_model}"}
    
    if new_model == CURRENT_MODEL:
        return {"type": "model_switched", "model": CURRENT_MODEL, "message": "Already using this model"}
    
    sys.stderr.write(f"[TTS Server] Switching from {CURRENT_MODEL} to {new_model}...\n")
    sys.stderr.flush()
    
    try:
        # Unload current model
        unload_current_model()
        
        # Update current model
        CURRENT_MODEL = new_model
        
        # Initialize new model
        if new_model == "chatterbox":
            model = initialize_chatterbox()
            if model is None:
                # Fallback to Kokoro if Chatterbox fails
                CURRENT_MODEL = "kokoro"
                initialize_kokoro()
                return {
                    "type": "model_switched",
                    "model": "kokoro",
                    "fallback": True,
                    "message": "Chatterbox failed, using Kokoro"
                }
        elif new_model == "chatterbox-turbo":
            model = initialize_chatterbox_turbo()
            if model is None:
                # Fallback to Kokoro if Chatterbox Turbo fails
                CURRENT_MODEL = "kokoro"
                initialize_kokoro()
                return {
                    "type": "model_switched",
                    "model": "kokoro",
                    "fallback": True,
                    "message": "Chatterbox Turbo failed, using Kokoro"
                }
        elif new_model == "chatterbox-full-mlx":
            model = initialize_chatterbox_full_mlx()
            if model is None:
                # Fallback to Kokoro if Chatterbox Full MLX fails
                CURRENT_MODEL = "kokoro"
                initialize_kokoro()
                return {
                    "type": "model_switched",
                    "model": "kokoro",
                    "fallback": True,
                    "message": "Chatterbox Full MLX failed, using Kokoro"
                }
        else:
            initialize_kokoro()
        
        # Get voices for current model
        if CURRENT_MODEL == "kokoro":
            voices = list(KOKORO_VOICES.keys())
        elif CURRENT_MODEL == "chatterbox-full-mlx":
            voices = ["default"]
        else:
            # Both chatterbox and chatterbox-turbo use same voices
            voices = list(CHATTERBOX_VOICES.keys())
        
        return {
            "type": "model_switched",
            "model": CURRENT_MODEL,
            "memory_mb": get_memory_mb(),
            "voices": voices
        }
        
    except Exception as e:
        sys.stderr.write(f"[TTS Server] Model switch failed: {e}\n")
        sys.stderr.flush()
        # Try to recover with Kokoro
        CURRENT_MODEL = "kokoro"
        try:
            initialize_kokoro()
        except Exception:
            pass
        return {"type": "error", "error": f"Model switch failed: {e}", "fallback_model": "kokoro"}


def handle_get_voices() -> dict:
    """Get available voices for current model."""
    if CURRENT_MODEL == "chatterbox":
        return {
            "type": "voices",
            "model": "chatterbox",
            "voices": CHATTERBOX_VOICES
        }
    elif CURRENT_MODEL == "chatterbox-turbo":
        # Turbo uses same voices as standard Chatterbox
        return {
            "type": "voices",
            "model": "chatterbox-turbo",
            "voices": CHATTERBOX_VOICES
        }
    elif CURRENT_MODEL == "chatterbox-full-mlx":
        # Full MLX uses pre-computed voice conditioning
        return {
            "type": "voices",
            "model": "chatterbox-full-mlx",
            "voices": {"default": "Default Voice (Pre-computed)"}
        }
    else:
        return {
            "type": "voices", 
            "model": "kokoro",
            "voices": KOKORO_VOICES
        }


def synthesize_with_chatterbox(text: str, voice: str = "aaron", speed: float = 1.0, 
                                output_file: str = None) -> dict:
    """Synthesize speech using Chatterbox TTS (chatterbox-mlx package)."""
    try:
        model = initialize_chatterbox()
        if model is None:
            return {"type": "error", "error": "Chatterbox model not loaded"}
        
        sample_rate = 24000  # Chatterbox uses 24kHz
        
        sys.stderr.write(f"[TTS Chatterbox] Synthesizing: {text[:100]}...\n")
        sys.stderr.flush()
        
        # Generate audio - returns torch tensor
        audio_tensor = model.generate(text=text)
        
        # Convert torch tensor to numpy
        if hasattr(audio_tensor, 'cpu'):
            audio_np = audio_tensor.cpu().numpy()
        else:
            audio_np = np.array(audio_tensor)
        
        # Squeeze to 1D if needed
        audio_np = audio_np.squeeze()
        
        if audio_np is None or len(audio_np) == 0:
            return {"type": "error", "error": "No audio generated by Chatterbox"}
        
        # Save to file
        if output_file:
            output_path = Path(output_file)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            sf.write(str(output_path), audio_np, sample_rate)
        
        # Check memory after generation (Chatterbox memory leak)
        check_memory_and_signal()
        
        return {
            "type": "success",
            "output_file": output_file,
            "sample_rate": sample_rate,
            "duration": len(audio_np) / sample_rate
        }
        
    except Exception as e:
        sys.stderr.write(f"[TTS Chatterbox] Synthesis error: {e}\n")
        sys.stderr.flush()
        return {"type": "error", "error": f"Chatterbox synthesis failed: {e}"}


def _split_text_into_chunks(text: str, max_chars: int = 200) -> list:
    """Split text into chunks at sentence boundaries for progressive playback."""
    import re
    
    # Clean up the text
    text = text.strip()
    if not text:
        return []
    
    # If short enough, return as single chunk
    if len(text) <= max_chars:
        return [text]
    
    chunks = []
    
    # Split into sentences (at . ! ? followed by space or end)
    sentences = re.split(r'(?<=[.!?])\s+', text)
    
    current_chunk = ""
    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence:
            continue
            
        # If adding this sentence would exceed max, save current and start new
        if current_chunk and len(current_chunk) + len(sentence) + 1 > max_chars:
            chunks.append(current_chunk.strip())
            current_chunk = sentence
        else:
            if current_chunk:
                current_chunk += " " + sentence
            else:
                current_chunk = sentence
    
    # Don't forget the last chunk
    if current_chunk:
        chunks.append(current_chunk.strip())
    
    # If we couldn't split (e.g., one very long sentence), force split at max_chars
    final_chunks = []
    for chunk in chunks:
        if len(chunk) <= max_chars:
            final_chunks.append(chunk)
        else:
            # Force split long chunks at word boundaries
            words = chunk.split()
            sub_chunk = ""
            for word in words:
                if sub_chunk and len(sub_chunk) + len(word) + 1 > max_chars:
                    final_chunks.append(sub_chunk.strip())
                    sub_chunk = word
                else:
                    sub_chunk = (sub_chunk + " " + word).strip()
            if sub_chunk:
                final_chunks.append(sub_chunk)
    
    return final_chunks


def synthesize_realtime_chatterbox(text: str, voice: str = "aaron", speed: float = 1.0,
                                    request_id: str = "0"):
    """Realtime synthesis using Chatterbox TTS (chatterbox-mlx package).
    
    Uses chunked synthesis for long texts - generates and yields each sentence/chunk
    immediately so playback can start while remaining chunks are still generating.
    This dramatically improves perceived latency for long texts.
    """
    import base64
    import io
    import time as _time
    
    _start_time = _time.time()
    
    try:
        model = initialize_chatterbox()
        if model is None:
            yield {"type": "error", "request_id": request_id, "error": "Chatterbox model not loaded"}
            return
        
        sample_rate = 24000  # Chatterbox uses 24kHz
        
        # Split text into chunks for progressive playback
        chunks = _split_text_into_chunks(text, max_chars=200)
        total_chunks = len(chunks)
        
        sys.stderr.write(f"[TTS Chatterbox Realtime] Starting: {len(text)} chars in {total_chunks} chunk(s)\n")
        sys.stderr.flush()
        
        total_duration = 0.0
        
        for chunk_idx, chunk_text in enumerate(chunks):
            chunk_start = _time.time()
            
            sys.stderr.write(f"[TTS Chatterbox Realtime] Chunk {chunk_idx+1}/{total_chunks}: '{chunk_text[:40]}...'\n")
            sys.stderr.flush()
            
            # Generate audio for this chunk
            audio_tensor = model.generate(text=chunk_text)
            
            chunk_gen_time = _time.time() - chunk_start
            
            # Convert torch tensor to numpy
            if hasattr(audio_tensor, 'cpu'):
                audio_np = audio_tensor.cpu().numpy()
            else:
                audio_np = np.array(audio_tensor)
            
            # Squeeze to 1D if needed
            audio_np = audio_np.squeeze()
            
            if audio_np is None or len(audio_np) == 0:
                sys.stderr.write(f"[TTS Chatterbox Realtime] Chunk {chunk_idx+1} produced no audio, skipping\n")
                sys.stderr.flush()
                continue
            
            duration = len(audio_np) / sample_rate
            total_duration += duration
            
            # Convert to WAV and base64
            wav_buffer = io.BytesIO()
            sf.write(wav_buffer, audio_np, sample_rate, format='WAV')
            wav_bytes = wav_buffer.getvalue()
            audio_base64 = base64.b64encode(wav_bytes).decode('utf-8')
            
            sys.stderr.write(f"[TTS Chatterbox Realtime] Chunk {chunk_idx+1}: {duration:.2f}s audio in {chunk_gen_time:.1f}s\n")
            sys.stderr.flush()
            
            # Yield this chunk immediately so playback can start
            yield {
                "type": "realtime_chunk",
                "request_id": request_id,
                "chunk_index": chunk_idx,
                "audio_base64": audio_base64,
                "sample_rate": sample_rate,
                "duration": duration,
                "text_hint": chunk_text[:30]
            }
        
        # Signal completion
        yield {
            "type": "realtime_complete",
            "request_id": request_id,
            "total_chunks": total_chunks,
            "total_duration": total_duration
        }
        
        # Check memory after generation
        check_memory_and_signal()
        
        sys.stderr.write(f"[TTS Chatterbox Realtime] Complete: {total_duration:.2f}s total in {total_chunks} chunks\n")
        sys.stderr.flush()
        
    except Exception as e:
        sys.stderr.write(f"[TTS Chatterbox Realtime] Error: {e}\n")
        sys.stderr.flush()
        yield {"type": "error", "request_id": request_id, "error": f"Chatterbox realtime synthesis failed: {e}"}


def synthesize_with_chatterbox_turbo(text: str, voice: str = "aaron", speed: float = 1.0, 
                                      output_file: str = None) -> dict:
    """Synthesize speech using Chatterbox Turbo TTS (CPU-only)."""
    try:
        model = initialize_chatterbox_turbo()
        if model is None:
            return {"type": "error", "error": "Chatterbox Turbo model not loaded"}
        
        sample_rate = model.sr  # Turbo model has .sr attribute
        
        sys.stderr.write(f"[TTS Chatterbox Turbo] Synthesizing: {text[:100]}...\n")
        sys.stderr.flush()
        
        # Generate audio - returns torch tensor
        audio_tensor = model.generate(text)
        
        # Convert torch tensor to numpy
        if hasattr(audio_tensor, 'cpu'):
            audio_np = audio_tensor.cpu().numpy()
        else:
            audio_np = np.array(audio_tensor)
        
        # Squeeze to 1D if needed
        audio_np = audio_np.squeeze()
        
        if audio_np is None or len(audio_np) == 0:
            return {"type": "error", "error": "No audio generated by Chatterbox Turbo"}
        
        # Save to file
        if output_file:
            output_path = Path(output_file)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            sf.write(str(output_path), audio_np, sample_rate)
        
        # Check memory after generation
        check_memory_and_signal()
        
        return {
            "type": "success",
            "output_file": output_file,
            "sample_rate": sample_rate,
            "duration": len(audio_np) / sample_rate
        }
        
    except Exception as e:
        sys.stderr.write(f"[TTS Chatterbox Turbo] Synthesis error: {e}\n")
        sys.stderr.flush()
        return {"type": "error", "error": f"Chatterbox Turbo synthesis failed: {e}"}


def synthesize_realtime_chatterbox_turbo(text: str, voice: str = "aaron", speed: float = 1.0,
                                          request_id: str = "0"):
    """Realtime synthesis using Chatterbox Turbo TTS (CPU-only).
    
    Note: Chatterbox Turbo doesn't have native streaming, so we generate all audio
    and send it as one chunk.
    """
    import base64
    import io
    
    try:
        model = initialize_chatterbox_turbo()
        if model is None:
            yield {"type": "error", "request_id": request_id, "error": "Chatterbox Turbo model not loaded"}
            return
        
        sample_rate = model.sr  # Turbo model has .sr attribute
        
        sys.stderr.write(f"[TTS Chatterbox Turbo Realtime] Starting: '{text[:80]}...'\n")
        sys.stderr.flush()
        
        # Generate audio
        audio_tensor = model.generate(text)
        
        # Convert torch tensor to numpy
        if hasattr(audio_tensor, 'cpu'):
            audio_np = audio_tensor.cpu().numpy()
        else:
            audio_np = np.array(audio_tensor)
        
        # Squeeze to 1D if needed
        audio_np = audio_np.squeeze()
        
        if audio_np is None or len(audio_np) == 0:
            yield {"type": "error", "request_id": request_id, "error": "No audio generated"}
            return
        
        duration = len(audio_np) / sample_rate
        
        # Convert to WAV and base64
        wav_buffer = io.BytesIO()
        sf.write(wav_buffer, audio_np, sample_rate, format='WAV')
        wav_bytes = wav_buffer.getvalue()
        audio_base64 = base64.b64encode(wav_bytes).decode('utf-8')
        
        sys.stderr.write(f"[TTS Chatterbox Turbo Realtime] Generated: {len(audio_np)} samples ({duration:.2f}s)\n")
        sys.stderr.flush()
        
        # Yield single chunk with all audio
        yield {
            "type": "realtime_chunk",
            "request_id": request_id,
            "chunk_index": 0,
            "audio_base64": audio_base64,
            "sample_rate": sample_rate,
            "duration": duration,
            "text_hint": text[:30]
        }
        
        # Signal completion
        yield {
            "type": "realtime_complete",
            "request_id": request_id,
            "total_chunks": 1,
            "total_duration": duration
        }
        
        # Check memory after generation
        check_memory_and_signal()
        
        sys.stderr.write(f"[TTS Chatterbox Turbo Realtime] Complete: {duration:.2f}s\n")
        sys.stderr.flush()
        
    except Exception as e:
        sys.stderr.write(f"[TTS Chatterbox Turbo Realtime] Error: {e}\n")
        sys.stderr.flush()
        yield {"type": "error", "request_id": request_id, "error": f"Chatterbox Turbo realtime synthesis failed: {e}"}


def synthesize_realtime_chatterbox_full_mlx(text: str, voice: str = "default", speed: float = 1.0,
                                             request_id: str = "0"):
    """Realtime synthesis using Chatterbox Full MLX - the fast, working version!
    
    This model runs at 1.25x realtime on Apple Silicon and produces high-quality speech.
    """
    import base64
    import io
    import time as _time
    
    try:
        model = initialize_chatterbox_full_mlx()
        
        if model is None:
            yield {"type": "error", "request_id": request_id, "error": "Chatterbox Full MLX model not loaded"}
            return
        
        sample_rate = 24000  # Chatterbox uses 24kHz
        
        sys.stderr.write(f"[TTS Chatterbox Full MLX] Starting: '{text[:80]}...'\n")
        sys.stderr.flush()
        
        start_time = _time.time()
        
        # Generate audio - returns a generator
        # Tuned parameters for natural voice:
        # - exaggeration: 0.35 = more expressive (default 0.1 is too flat)
        # - cfg_weight: 0.3 = less robotic/metallic (default 0.5 is too synthetic)
        # - temperature: 0.7 = slightly more consistent
        result = model.generate(
            text,
            exaggeration=0.35,      # More expressive (default 0.1)
            cfg_weight=0.3,         # Less metallic (default 0.5)
            temperature=0.7,        # Slightly more consistent (default 0.8)
            speed=speed,
        )
        results = list(result)
        
        gen_time = _time.time() - start_time
        
        # Extract audio from GenerationResult
        if results and hasattr(results[0], 'audio'):
            audio_np = np.array(results[0].audio).squeeze()
        else:
            yield {"type": "error", "request_id": request_id, "error": "No audio generated"}
            return
        
        if audio_np is None or len(audio_np) == 0:
            yield {"type": "error", "request_id": request_id, "error": "Empty audio generated"}
            return
        
        duration = len(audio_np) / sample_rate
        rtf = duration / gen_time if gen_time > 0 else 0
        
        # Convert to WAV and base64
        wav_buffer = io.BytesIO()
        sf.write(wav_buffer, audio_np, sample_rate, format='WAV')
        wav_bytes = wav_buffer.getvalue()
        audio_base64 = base64.b64encode(wav_bytes).decode('utf-8')
        
        sys.stderr.write(f"[TTS Chatterbox Full MLX] Generated: {duration:.2f}s in {gen_time:.2f}s (RTF: {rtf:.2f}x)\n")
        sys.stderr.flush()
        
        # Yield single chunk with all audio
        yield {
            "type": "realtime_chunk",
            "request_id": request_id,
            "chunk_index": 0,
            "audio_base64": audio_base64,
            "sample_rate": sample_rate,
            "duration": duration,
            "text_hint": text[:30]
        }
        
        # Signal completion
        yield {
            "type": "realtime_complete",
            "request_id": request_id,
            "total_chunks": 1,
            "total_duration": duration
        }
        
        # Check memory after generation
        check_memory_and_signal()
        
        sys.stderr.write(f"[TTS Chatterbox Full MLX] Complete: {duration:.2f}s\n")
        sys.stderr.flush()
        
    except Exception as e:
        sys.stderr.write(f"[TTS Chatterbox Full MLX] Error: {e}\n")
        sys.stderr.flush()
        import traceback
        traceback.print_exc(file=sys.stderr)
        yield {"type": "error", "request_id": request_id, "error": f"Chatterbox Full MLX synthesis failed: {e}"}


def main():
    """Main server loop - reads JSON commands from stdin"""
    global CURRENT_MODEL
    
    # Parse command line arguments for initial model
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', choices=['kokoro', 'chatterbox', 'chatterbox-turbo', 'chatterbox-full-mlx'], default='kokoro',
                        help='Initial TTS model to load')
    args, unknown = parser.parse_known_args()  # Use parse_known_args to handle any extra args
    
    # Set the initial model from command line
    CURRENT_MODEL = args.model
    sys.stderr.write(f"[TTS Server] Command line args: {sys.argv}\n")
    sys.stderr.write(f"[TTS Server] Parsed model arg: {args.model}\n")
    sys.stderr.write(f"[TTS Server] Starting with CURRENT_MODEL: {CURRENT_MODEL}\n")
    sys.stderr.flush()
    
    # Send ready signal with the model we're about to load
    sys.stderr.write(f"[TTS Server] Sending ready with model: {CURRENT_MODEL}\n")
    sys.stderr.flush()
    print(json.dumps({"type": "ready", "model": CURRENT_MODEL}), flush=True)
    
    # Pre-load model immediately for faster first request
    # Note: model_loaded is sent from within initialize_model() as soon as the model is loaded
    # This allows TypeScript to start accepting requests while warmup continues in background
    try:
        initialize_model()
        # Signal warmup is complete (model_loaded was already sent earlier)
        print(json.dumps({"type": "warmup_complete"}), flush=True)
    except Exception as e:
        print(json.dumps({"type": "error", "error": f"Failed to load model: {e}"}), flush=True)
    
    # Process commands
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
            
        try:
            cmd = json.loads(line)
            
            if cmd.get("action") == "synthesize":
                result = synthesize(
                    text=cmd.get("text", ""),
                    voice=cmd.get("voice", "af_heart"),
                    speed=cmd.get("speed", 1.0),
                    output_file=cmd.get("output")
                )
                print(json.dumps(result), flush=True)
            
            elif cmd.get("action") == "synthesize_stream":
                # Legacy streaming mode - send chunks as they're generated
                for chunk_result in synthesize_streaming(
                    text=cmd.get("text", ""),
                    voice=cmd.get("voice", "af_heart"),
                    speed=cmd.get("speed", 1.0),
                    output_dir=cmd.get("output_dir", "/tmp"),
                    request_id=cmd.get("request_id", "0")
                ):
                    print(json.dumps(chunk_result), flush=True)
            
            elif cmd.get("action") == "synthesize_realtime":
                # True realtime streaming - no file I/O, immediate audio delivery
                for chunk_result in synthesize_realtime(
                    text=cmd.get("text", ""),
                    voice=cmd.get("voice", "af_heart"),
                    speed=cmd.get("speed", 1.0),
                    request_id=cmd.get("request_id", "0")
                ):
                    print(json.dumps(chunk_result), flush=True)
                
            elif cmd.get("action") == "switch_model":
                # Switch between TTS models (kokoro/chatterbox)
                new_model = cmd.get("model", "kokoro")
                result = handle_switch_model(new_model)
                print(json.dumps(result), flush=True)
            
            elif cmd.get("action") == "get_voices":
                # Get available voices for current model
                result = handle_get_voices()
                print(json.dumps(result), flush=True)
            
            elif cmd.get("action") == "get_status":
                # Get current TTS status
                if CURRENT_MODEL == "kokoro":
                    voices = KOKORO_VOICES
                else:
                    # Both chatterbox and chatterbox-turbo use same voices
                    voices = CHATTERBOX_VOICES
                result = {
                    "type": "status",
                    "current_model": CURRENT_MODEL,
                    "memory_mb": get_memory_mb(),
                    "baseline_mb": BASELINE_MEMORY_MB,
                    "voices": voices
                }
                print(json.dumps(result), flush=True)
            
            elif cmd.get("action") == "ping":
                print(json.dumps({"type": "pong"}), flush=True)
                
            elif cmd.get("action") == "quit":
                print(json.dumps({"type": "goodbye"}), flush=True)
                break
                
            else:
                print(json.dumps({"type": "error", "error": f"Unknown action: {cmd.get('action')}"}), flush=True)
                
        except json.JSONDecodeError as e:
            print(json.dumps({"type": "error", "error": f"Invalid JSON: {e}"}), flush=True)
        except Exception as e:
            print(json.dumps({"type": "error", "error": f"Error: {e}"}), flush=True)


if __name__ == "__main__":
    main()

