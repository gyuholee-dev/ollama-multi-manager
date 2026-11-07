-- 환경설정: key-value 테이블. value는 JSON 문자열로 저장한다 (예: '"dark"', 'true', '3', 'null').
CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL CHECK (json_valid(value)),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) WITHOUT ROWID;

-- 기본값. 이미 값이 있으면 덮어쓰지 않는다.
-- null = 앱이 OS별 기본 경로/자동 탐색으로 처리한다.
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('language',                   'null'),       -- null = 시스템 로케일 자동 감지 (en | ko ...)
    ('theme',                      '"system"'),   -- system | light | dark
    ('launch_at_login',            'false'),
    ('minimize_to_tray',           'false'),
    ('external_monitoring_enabled','true'),
    ('external_monitoring_port',   '9100'),
    ('refresh_interval_seconds',   '3'),
    ('ollama_executable_path',     'null'),
    ('default_models_path',        'null');       -- OLLAMA_MODELS 기본값

-- 인스턴스: 설정값(options)은 JSON.
-- desired_state = 앱 종료 시점에 저장한 실행 상태. 앱을 다시 시작하면 'running'이던 인스턴스를 시작한다.
-- pid, pid_started = 비정상 종료로 남은 프로세스를 찾아 정리하기 위한 값. pid_started는 프로세스 생성 시각(epoch 초)이며
--                    PID가 다른 프로세스에 재사용된 경우를 걸러낸다.
CREATE TABLE IF NOT EXISTS instances (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL UNIQUE,
    port          INTEGER NOT NULL UNIQUE CHECK (port BETWEEN 1024 AND 65535),
    options       TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(options)),
    desired_state TEXT    NOT NULL DEFAULT 'stopped' CHECK (desired_state IN ('running', 'stopped')),
    pid           INTEGER,
    pid_started   REAL,
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 끝나지 않은 모델 다운로드. 앱을 껐다 켜도 카드가 남고, 다시 받으면 Ollama가 받던 파일에서 이어받는다.
-- digests = 받던 레이어의 다이제스트 목록(삭제할 때 남은 부분 파일을 찾는 데 쓴다).
CREATE TABLE IF NOT EXISTS downloads (
    model     TEXT    PRIMARY KEY,
    completed INTEGER NOT NULL DEFAULT 0,
    total     INTEGER NOT NULL DEFAULT 0,
    digests   TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(digests))
);
