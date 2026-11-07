-- 환경설정: key-value 테이블. value는 JSON 문자열로 저장한다 (예: '"dark"', 'true', '3', 'null').
CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL CHECK (json_valid(value)),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) WITHOUT ROWID;

-- 기본값. 이미 값이 있으면 덮어쓰지 않는다.
-- null = 앱이 OS별 기본 경로/자동 탐색으로 처리한다.
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('theme',                      '"system"'),   -- system | light | dark
    ('launch_at_login',            'false'),
    ('minimize_to_tray',           'false'),
    ('external_monitoring_enabled','true'),
    ('external_monitoring_port',   '9100'),
    ('refresh_interval_seconds',   '3'),
    ('ollama_executable_path',     'null'),
    ('default_models_path',        'null');       -- OLLAMA_MODELS 기본값
