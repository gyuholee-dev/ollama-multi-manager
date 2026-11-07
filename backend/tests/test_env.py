from app.schemas import InstanceOptions
from app.services.instances import build_env


def test_build_env_maps_every_option():
    o = InstanceOptions(gpu=1, context_length=8192, keep_alive_min=30, max_loaded_models=2,
                        num_parallel=4, flash_attention=True, kv_cache_type="q8_0", models_path="/m")
    e = build_env(11436, o, {"PATH": "/bin", "CUDA_VISIBLE_DEVICES": "9"})
    assert e["OLLAMA_HOST"] == "127.0.0.1:11436"
    assert e["OLLAMA_CONTEXT_LENGTH"] == "8192"
    assert e["OLLAMA_KEEP_ALIVE"] == "30m"
    assert e["OLLAMA_MAX_LOADED_MODELS"] == "2" and e["OLLAMA_NUM_PARALLEL"] == "4"
    assert e["OLLAMA_FLASH_ATTENTION"] == "1" and e["OLLAMA_KV_CACHE_TYPE"] == "q8_0"
    assert e["CUDA_VISIBLE_DEVICES"] == "1"
    assert e["OLLAMA_MODELS"] == "/m" and e["PATH"] == "/bin"


def test_gpu_auto_clears_inherited_selection_and_cpu_disables():
    base = {"CUDA_VISIBLE_DEVICES": "3"}
    assert "CUDA_VISIBLE_DEVICES" not in build_env(1, InstanceOptions(gpu="auto"), base)
    assert build_env(1, InstanceOptions(gpu="cpu"), base)["CUDA_VISIBLE_DEVICES"] == "-1"


def test_keep_alive_never_and_default_models_path():
    e = build_env(1, InstanceOptions(keep_alive_min=-1), {}, default_models="/default")
    assert e["OLLAMA_KEEP_ALIVE"] == "-1" and e["OLLAMA_MODELS"] == "/default"
    assert build_env(1, InstanceOptions(models_path="/own"), {}, default_models="/default")["OLLAMA_MODELS"] == "/own"
