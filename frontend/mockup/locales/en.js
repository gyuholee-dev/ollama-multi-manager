// English (fallback language). To add a language: copy this file to locales/<code>.js,
// change the key below and the values, then add a <script> tag for it in index.html.
// Placeholders such as {n} are filled in by t(key, {n: ...}). Log messages are not translated.
(window.LOCALES ??= {}).en = {
  _name: 'English',
  'app.title': 'Ollama Multi Manager (mockup)',

  'hdr.new': 'New instance', 'hdr.models': 'Models', 'hdr.settings': 'Settings',
  'srv.title': 'Web access · {a}',

  'sec.sum': 'Summary', 'sec.mon': 'System monitor', 'sec.inst': 'Server instances', 'sec.logs': 'Logs',
  'sec.hide': 'Hide', 'sec.show': 'Show',

  'btn.cancel': 'Cancel', 'btn.create': 'Create', 'btn.start': 'Start', 'btn.stop': 'Stop',
  'btn.details': 'Details', 'btn.delete': 'Delete', 'del.disabled': 'Cannot delete while running',
  'pop.ok': 'OK', 'pop.cont': 'Continue',

  'f.name': 'Name', 'f.port': 'Port', 'f.state': 'Status', 'f.ctx': 'Context', 'f.keep': 'Expiry',
  'f.maxLoaded': 'Concurrent loaded models', 'f.parallel': 'Concurrent requests',
  'f.device': 'Compute device', 'f.kvq': 'KV cache quantization', 'f.flash': 'Flash attention',
  'opt.f16': 'f16 (default)',
  'u.cnt': '', 'u.case': '',
  'keep.unlimited': 'Unlimited', 'keep.min': '{n} min', 'keep.hour': '{n} h', 'keep.day': '{n} d',
  'exp.none': 'No expiry', 'exp.at': 'Expires {t}',
  'mon.util': 'Usage', 'mon.unified': 'UMA', 'mon.gpuMax': 'GPU max {limit} GB', 'mon.gpuOther': 'Other GPU', 'mon.unsupported': 'Not supported', 'mock.gpu': 'Mockup: GPU state', 'mock.gpu.nv': 'Apple M4 Pro (powermetrics) + RTX 5090 (mixed)', 'mock.gpu.mac': 'Apple silicon (no powermetrics)', 'mock.gpu.part': 'Partial (no use or temperature)', 'mock.gpu.none': 'Not supported (no GPU)', 'gpu.auto': 'Auto', 'gpu.n': 'GPU-{g} · {name}',

  'state.running': 'Running', 'state.stopped': 'Stopped', 'state.starting': 'Starting', 'state.unreachable': 'Unresponsive',

  'new.title': 'New instance', 'new.server': 'Server', 'new.general': 'General', 'new.advanced': 'Advanced',
  'new.generalT': 'Expand/collapse General', 'new.advancedT': 'Expand/collapse Advanced',
  'new.models': 'Served models', 'new.toggle': 'Expand/collapse {n}', 'new.noModels': 'No models downloaded',

  'log.all': 'All', 'log.app': 'App',
  'ext.name': 'Default instance', 'ext.managed': 'Externally managed',
  'card.none': 'No model loaded', 'card.line': 'Port {port} · Context {ctx} · {mem} {gb}',

  'sum.ins': 'Instances', 'sum.usage': 'Usage', 'sum.perf': 'Performance', 'sum.status': 'Status',
  'sum.empty': 'Nothing to show.',
  'c.total': 'Total', 'c.running': 'Running', 'c.stopped': 'Stopped', 'c.unreach': 'Unresponsive',
  'c.mem': 'Memory', 'c.models': 'Loaded models', 'c.reqs': 'Active requests', 'c.latency': 'Avg. response',
  'c.speed': 'Avg. speed', 'c.warn': 'Warnings', 'c.ok': 'Normal', 'c.errs': 'Recent errors',
  'c.mon': 'Web access', 'c.on': 'On', 'c.off': 'Off', 'c.updated': 'Updated',

  'mon.cpu': '{pct}% · {n} cores', 'mon.system': 'System', 'mon.other': 'Other', 'mon.gpus': '{n} GPUs',

  'd.pid': 'PID', 'd.uptime': 'Uptime', 'd.up': '2 h 14 min', 'd.none': 'None', 'd.models': 'Models',
  'd.loaded': 'Loaded models', 'd.avail': 'Available models', 'd.res': 'Resources', 'd.vram': '{mem} usage',
  'd.reqs': 'Request handling', 'd.reqsV': '{n} in progress',

  'set.title': 'Settings', 'set.general': 'General', 'set.login': 'Launch at system startup',
  'set.tray': 'Minimize to tray', 'set.lang': 'Language', 'set.theme': 'Theme',
  'theme.system': 'System', 'theme.light': 'Light', 'theme.dark': 'Dark',
  'set.monitor': 'Monitor', 'set.extAddrOff': 'Not allowed', 'set.extAddr': 'Remote monitoring address', 'btn.copy': 'Copy', 'btn.copied': 'Copied', 'set.web': 'Remote monitoring', 'set.ext': 'Allow remote monitoring', 'set.extPwHint': 'Left empty, the screen is only seen read-only (guest), with no sign-in. With a password, whoever signs in can also start, stop and delete instances and change settings on the web.', 'btn.genKey': 'Generate', 'key.short': 'The API key needs at least {n} characters.', 'ext.tokenSaved': 'Metrics API key saved. The previous key no longer works.', 'ext.tokenCleared': 'Metrics API key removed. /metrics can no longer be read.', 'set.mxToken': 'Metrics API key', 'set.mxTokenHint': 'Left empty, /metrics cannot be read. To read it, send an Authorization: Bearer <API key> header.', 'set.extHint': 'When on, the web screen and the metrics are served on the port below. Without a password the screen opens read-only (guest), so turn it on only on a network you trust.', 'set.extPw': 'Web admin password', 'set.extPwSet': 'Set (type to change)', 'set.extPwUnset': 'Not set', 'set.extPort': 'Remote monitoring port',
  'day.n': '{n} d', 'set.defOllama': 'Show default Ollama', 'set.defOllamaHint': "Shows an Ollama running on this PC's port 11434 as a read-only card.", 'set.vramWarn': 'VRAM warning level', 'set.vramWarnHint': "When GPU memory use goes above this, the summary and the system monitor show a warning, and starting an instance asks for confirmation.", 'set.intervalHint': "How often CPU, memory, GPU and per-instance use are read and the screen is refreshed. Shorter is smoother but costs more load. Instance state changes and logs show at once.", 'set.keep': 'Statistics kept for', 'set.keepHint': 'How long the per-minute statistics (requests, failures, tokens, response times) are kept. It does not affect saved request content (prompts and answers) or logs.', 'set.pm': 'Use powermetrics', 'set.pmHint': '[Deferred] On a Mac (Apple silicon), reads the GPU use of each instance. Needs the administrator password.', 'set.interval': 'Reading refresh interval', 'sec.n': '{n} s',
  'set.exe': 'Ollama executable', 'set.exePh': 'Auto-detect if empty', 'set.browse': 'Browse',
  'set.models': 'Model path (OLLAMA_MODELS default)', 'set.update': 'Update',
  'set.ver': 'Current version {v}', 'set.check': 'Check for updates', 'set.checking': 'Checking…',
  'set.reset': 'Defaults', 'set.save': 'Save',

  'upd.title': 'Update check', 'upd.latest': 'You are up to date. ({v})',
  'rst.title': 'Reset settings', 'rst.msg': 'All settings will be reset to their defaults and saved.', 'rst.ok': 'Reset',
  'port.conflict': 'Port conflict',
  'sv.portMsg': 'Web access port {p} is used by an instance.\nChoose a different port.',
  'ext.title': 'Web access', 'ext.msg': 'The web access server will restart on port {p}.',
  'rr.t': 'Restart required', 'rr.m': 'Restart the running instances to apply the new executable or model path.',

  'mdl.param': 'Parameters {p} · Quantization {q}', 'mdl.estimate': 'Estimate for the current environment',
  'mdl.installed': 'Installed models', 'mdl.derived': 'Derived', 'mdl.clone': 'Copy', 'mdl.edit': 'Edit', 'mdl.back': 'Back', 'btn.close': 'Close',
  'mdl.clone.name': 'New model name', 'mdl.clone.create': 'Create', 'mdl.clone.same.title': 'Same name', 'mdl.clone.same.msg': 'Enter a name other than the original\'s.',
  'mdl.edit.info': 'Info', 'mdl.edit.settings': 'Settings', 'mdl.edit.raw': 'Source', 'mdl.edit.hint': 'Saving changes the settings of this model. Its weights stay; a field left empty keeps its present value (it is not cleared).', 'mdl.edit.unset': 'not set', 'mdl.edit.save': 'Save',
  'mdl.edit.saved.title': 'Saved', 'mdl.edit.saved.msg': 'The settings of {n} were changed.',
  'mdl.info.size': 'Size', 'mdl.info.paramSize': 'Parameters', 'mdl.info.quant': 'Quantization', 'mdl.info.parent': 'Base',
  'mdl.derivedFrom': 'Base: {n}', 'mdl.detail.ctx': 'Max context', 'mdl.detail.params': 'Settings it sets', 'mdl.detail.abilities': 'Abilities', 'mdl.derive.system': 'System prompt',
  'mdl.derive.exists.title': 'Model exists', 'mdl.derive.exists.msg': '{n} already exists. Creating it again replaces its settings.', 'mdl.derive.replace': 'Replace',
  'mdl.p.num_ctx': 'Context length (num_ctx)', 'mdl.p.num_gpu': 'GPU layers (num_gpu)', 'mdl.p.temperature': 'temperature', 'mdl.p.top_p': 'top_p', 'mdl.p.top_k': 'top_k', 'mdl.p.repeat_penalty': 'repeat_penalty',
  'mdl.del.derived': '{k} derived model(s) were made from it. They are not deleted.', 'mdl.del.frees': 'Space freed by deleting it: {size} (files shared with other models are not counted)',
  'mdl.library': 'Library', 'mdl.none': 'No models installed.', 'mdl.stats': '{path} · {n} models · {size} on disk',
  'mdl.download': 'Download', 'mdl.dlPh': 'Model to download (e.g. qwen3:8b-q4_K_M)',
  'mdl.dup.title': 'Already installed', 'mdl.dup.msg': '{n} is already installed.',
  'mdl.empty.title': 'Model name required', 'mdl.empty.msg': 'Enter the name of the model to download.',
  'mdl.progress': 'Downloading {n}… {p}%', 'mdl.done.title': 'Download complete', 'mdl.done.msg': '{n} has been installed.',
  'mdl.del.title': 'Delete model', 'mdl.del.msg': 'The file for {n} will be deleted.',
  'mdl.del.used': 'It will also become unavailable to the instances using it ({u}).',

  'inst.del.title': 'Delete instance',
  'inst.del.msg': '{n} will be deleted.\nIt is stopped first. Model files are not deleted.',

  'v.nameReq.t': 'Name required', 'v.nameReq.m': 'Enter an instance name.',
  'v.nameDup.t': 'Duplicate name', 'v.nameDup.m': 'The name {n} is already in use.',
  'v.port.t': 'Invalid port', 'v.port.m': 'The port must be between 1024 and 65535.',
  'v.used.m': 'Port {p} is already in use.',

  'w.vram.t': 'High VRAM usage',
  'w.vram.m': 'VRAM usage is currently {pct}%.\nStarting {n} and loading models may unload models from other instances or fail to load.',
  'w.stop.t': 'Stop instance',
  'w.stop.m': '{n} will be stopped.\n{k} loaded model(s) will be unloaded and requests in progress will be interrupted.',
  'w.fitUma.t': 'Memory may run short', 'w.fitUma.m': 'The models loaded together need about {need} GB, but about {cap} GB can be used now.\n(the smaller of the pool\'s free {avail} GB and the {room} GB left under the GPU maximum)\nIf you go on, the system may slow down or part of it may run on the CPU.', 'w.fitUma.cpu': 'The models loaded together need about {need} GB, but about {cap} GB is free now.\nIf you go on, the system may slow down.', 'w.fit.t': 'VRAM may be insufficient',
  'w.fit.m': 'The models loaded at the same time need about {need} GB, which exceeds the available VRAM of the selected device ({cap} GB).\nCreate it anyway?',
  'btn.monitor': 'Monitor', 'im.title': '{n} monitor', 'im.now': 'Now', 'im.ttft': 'First token', 'im.window': 'Last {m} min', 'im.hour': 'Last hour', 'f.saveReq': 'Save request content', 'f.saveReqHint': 'Prompts and answers are stored as they are in a log file on this PC.', 'rq.client': 'Client', 'rq.asked': 'Request', 'rq.answered': 'Answer', 'rq.notSaved': 'The content of this request was not saved (the instance option "Save request content" was off).', 'rq.noDetail': 'Could not load the details.', 'im.total': 'Requests (total/failed)', 'im.tokIn': 'Input tokens', 'im.tokOut': 'Output tokens', 'im.reqs': 'Requests per minute', 'im.speed': 'Token speed per minute', 'im.latency': 'Average response per minute', 'im.live': 'Live resources', 'im.collecting': 'Collecting data. The graphs appear in a moment.', 'im.span': '{m} min ago', 'im.nowEdge': 'now', 'im.hourAgo': '60 min ago', 'im.conc': 'Concurrent requests (running + queued)', 'new.modelsHint': 'Select at least one model for this instance to use. Requests for models you did not select are rejected.', 'rq.byModel': 'By model (last 5 min)', 'rq.recent': 'Recent requests', 'rq.none': 'No requests yet.', 'rq.model': 'Model', 'rq.count': 'Requests', 'rq.speed': 'Speed', 'rq.avg': 'Avg. response', 'rq.time': 'Time', 'rq.path': 'Path', 'rq.status': 'Status', 'rq.dur': 'Took', 'rq.tok': 'Tokens (in/out)', 'rq.cancelled': 'Cancelled', 'mdl.paused': 'Paused', 'mdl.failed': 'Failed', 'btn.pause': 'Pause', 'btn.resume': 'Resume', 'c.queued': 'waiting', 'c.fail': 'Failed',
  'mdl.dl.del.title': 'Delete download', 'mdl.dl.del.msg': 'The download of {n} will be stopped and the files received so far deleted.',
  'im.history': 'History', 'im.log': 'Log', 'im.logNone': 'No log lines yet.'
};
