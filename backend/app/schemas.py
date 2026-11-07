"""Request models."""
from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

Port = Annotated[int, Field(ge=1024, le=65535)]
Name = Annotated[str, Field(min_length=1, max_length=40, pattern=r"^\S(.*\S)?$")]


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


class InstanceCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Name
    port: Port
    options: InstanceOptions = InstanceOptions()


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
    refresh_interval_seconds: Annotated[int, Field(ge=1, le=60)] | None = None
    ollama_executable_path: str | None = None
    default_models_path: str | None = None


class StopRequest(BaseModel):
    """Optional body of stop/restart: wait up to this long for running requests before stopping."""

    model_config = ConfigDict(extra="forbid")

    drain_seconds: Annotated[int, Field(ge=0, le=600)] = 0


class PullRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model: Annotated[str, Field(min_length=1, max_length=200)]
