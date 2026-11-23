import io
import logging

from app.logsetup import served_urls, setup_logging, terminal_level


def _flush() -> None:
    for handler in logging.getLogger().handlers:
        handler.flush()


def test_everything_goes_to_the_file_and_the_terminal_shows_info_and_above(tmp_path):
    out = io.StringIO()
    setup_logging(tmp_path, stream=out, env={})
    log = logging.getLogger("omm.test")
    log.debug("detail")
    log.info("hello")
    log.warning("careful")
    log.error("broken")
    _flush()
    lines = out.getvalue().strip().splitlines()
    assert [line.split("] ", 1)[1] for line in lines] == ["hello", "WARNING careful", "ERROR broken"]
    assert lines[0].endswith("Z [backend] hello") and lines[0][4] == "-" and lines[0][10] == "T"
    file = (tmp_path / "backend.log").read_text(encoding="utf-8").strip().splitlines()
    assert len(file) == 4
    assert file[0].endswith("DEBUG [backend] detail") and file[1].endswith("INFO  [backend] hello")


def test_the_terminal_level_can_be_changed_but_not_what_the_file_has(tmp_path):
    out = io.StringIO()
    assert terminal_level({}) == logging.INFO and terminal_level({"OMM_LOG_LEVEL": "DEBUG"}) == logging.DEBUG
    assert terminal_level({"OMM_LOG_LEVEL": "loud"}) == logging.INFO
    setup_logging(tmp_path, stream=out, env={"OMM_LOG_LEVEL": "error"})
    logging.getLogger("omm.test").info("quiet")
    logging.getLogger("omm.test").error("loud")
    _flush()
    assert len(out.getvalue().strip().splitlines()) == 1
    assert len((tmp_path / "backend.log").read_text(encoding="utf-8").strip().splitlines()) == 2


def test_the_requests_of_the_collector_are_not_logged(tmp_path):
    out = io.StringIO()
    setup_logging(tmp_path, stream=out, env={})
    logging.getLogger("httpx").info('HTTP Request: GET http://127.0.0.1:11434/api/ps "HTTP/1.1 200 OK"')
    logging.getLogger("httpx").warning("a real problem")
    _flush()
    assert "api/ps" not in (tmp_path / "backend.log").read_text(encoding="utf-8")
    assert "a real problem" in out.getvalue()


def test_an_exception_is_in_the_file_with_its_trace(tmp_path):
    setup_logging(tmp_path, stream=io.StringIO(), env={})
    try:
        raise ValueError("boom")
    except ValueError:
        logging.getLogger("omm.test").exception("failed")
    _flush()
    text = (tmp_path / "backend.log").read_text(encoding="utf-8")
    assert "ERROR [backend] failed" in text and "ValueError: boom" in text


def test_where_a_server_can_be_reached():
    assert served_urls("0.0.0.0", 9101, "/mcp", "192.168.0.24") == "http://127.0.0.1:9101/mcp and http://192.168.0.24:9101/mcp"
    assert served_urls("0.0.0.0", 9100, "/", None) == "http://127.0.0.1:9100/"
    assert served_urls("10.0.0.5", 9100, "/", "192.168.0.24") == "http://10.0.0.5:9100/"
