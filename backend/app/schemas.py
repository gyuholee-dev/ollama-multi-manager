"""Request models."""
from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.services.webauth import MIN_API_KEY_LENGTH

Port = Annotated[int, Field(ge=1024, le=65535)]
Name = Annotated[str, Field(min_length=1, max_length=40, pattern=r"^\S(.*\S)?$")]


ModelNames = Annotated[list[Annotated[str, Field(min_length=1, max_length=200)]], Field(max_length=500)]


class InstanceOptions(BaseModel):
    """Per-instance Ollama settings; each field maps to an environment variable (see build_env)."""

    model_config = ConfigDict(extra="forbid")

    gpu: Literal["auto", "cpu"] | Annotated[int, Field(ge=0, le=63)] = "auto"
    context_length: Annotated[int, Field(ge=512, le=1_048_576)] = 4096
    keep_alive_min: Annotated[int, Field(ge=-1)] = 5  # -1 = never unload
    max_loaded_models: Annotated[int, Field(ge=1, le=64)] = 1
    num_parallel: Annotated[int, Field(ge=1, le=64)] = 1
    flash_attention: bool = False
    kv_cache_type: Literal["f16", "q8_0", "q4_0"] = "f16"
    models_path: str | None = None  # None = use the default_models_path setting
    listen: Literal["local", "lan"] = "local"  # who can reach the instance's port: this PC only, or the whole network
    auto_start: bool = False  # start the instance when a request arrives while it is stopped
    idle_stop_min: Annotated[int, Field(ge=0, le=1440)] = 0  # with auto_start: stop after this many idle minutes (0 = never)
    api_key: Annotated[str, Field(min_length=MIN_API_KEY_LENGTH, max_length=128, pattern=r"^\S+$")] | None = None  # clients must send it as a Bearer token
    save_requests: bool = False  # keep the content of requests and answers in the instance's request journal
    allowed_models: ModelNames = []  # the models this instance serves; empty = every installed model (enforced by the proxy)


class InstanceCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Name
    port: Port
    options: InstanceOptions = InstanceOptions()


class AllowedModels(BaseModel):
    model_config = ConfigDict(extra="forbid")

    models: ModelNames


class InstanceUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Name | None = None
    port: Port | None = None
    options: InstanceOptions | None = None


class SettingsPatch(BaseModel):
    """Partial update: only fields present in the request body are applied."""

    model_config = ConfigDict(extra="forbid")

    language: str | None = None
    theme: Literal["system", "light", "dark"] | None = None
    launch_at_login: bool | None = None
    minimize_to_tray: bool | None = None
    external_monitoring_enabled: bool | None = None
    external_monitoring_port: Port | None = None
    external_monitoring_password: Annotated[str, Field(max_length=200)] | None = None  # write-only; "" removes it
    external_monitoring_metrics_token: Annotated[str, Field(max_length=200)] | None = None  # write-only; "" removes it
    external_monitoring_session_hours: Annotated[int, Field(ge=1, le=720)] | None = None
    refresh_interval_seconds: Annotated[int, Field(ge=1, le=60)] | None = None
    monitor_default_ollama: bool | None = None
    history_keep_days: Annotated[int, Field(ge=1, le=365)] | None = None
    vram_warn_percent: Annotated[int, Field(ge=50, le=99)] | None = None
    ollama_executable_path: str | None = None
    default_models_path: str | None = None


class StopRequest(BaseModel):
    """Optional body of stop/restart: wait up to this long for running requests before stopping."""

    model_config = ConfigDict(extra="forbid")

    drain_seconds: Annotated[int, Field(ge=0, le=600)] = 0


class ModelParameters(BaseModel):
    """The settings a derived model may set (what the form offers); anything else goes through a Modelfile (not offered yet)."""

    model_config = ConfigDict(extra="forbid")

    num_ctx: Annotated[int, Field(ge=128, le=1_048_576)] | None = None
    num_gpu: Annotated[int, Field(ge=0, le=999)] | None = None  # layers on the GPU (999 = all)
    temperature: Annotated[float, Field(ge=0, le=5)] | None = None
    top_p: Annotated[float, Field(ge=0, le=1)] | None = None
    top_k: Annotated[int, Field(ge=0, le=1000)] | None = None
    repeat_penalty: Annotated[float, Field(ge=0, le=5)] | None = None


class ModelCreate(BaseModel):
    """A new model tag made from an installed one: the same weights, with other settings."""

    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, Field(min_length=1, max_length=200)]
    base: Annotated[str, Field(min_length=1, max_length=200)]
    parameters: ModelParameters = ModelParameters()
    system: Annotated[str, Field(max_length=20_000)] | None = None


class PullRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model: Annotated[str, Field(min_length=1, max_length=200)]
