// 한국어. 영어(en.ts)에 없는 키는 영어로 표시된다. {n} 같은 자리표시자는 t(키, { n })으로 채운다. 로그 메시지는 번역하지 않는다.
import type { Messages } from './types';

const ko: Messages = {
  _name: '한국어',
  'app.title': 'Ollama Multi Manager',

  'hdr.new': '새 인스턴스', 'hdr.models': '모델 관리', 'hdr.settings': '환경설정',
  'srv.title': '웹 접속 · {a}',

  'sec.sum': '요약', 'sec.mon': '시스템 모니터', 'sec.inst': '서버 인스턴스', 'sec.logs': '로그',
  'sec.hide': '숨기기', 'sec.show': '펼치기',

  'btn.cancel': '취소', 'btn.create': '생성', 'btn.start': '시작', 'btn.stop': '종료',
  'btn.details': '상세', 'btn.delete': '삭제', 'del.disabled': '실행 중에는 삭제할 수 없습니다',
  'pop.ok': '확인', 'pop.cont': '계속',

  'f.name': '이름', 'f.port': '포트', 'f.state': '상태', 'f.ctx': '컨텍스트', 'f.keep': '만료 시간',
  'f.maxLoaded': '동시 로드 모델 수', 'f.parallel': '동시 요청 수',
  'f.device': '연산 장치', 'f.kvq': 'KV 캐시 양자화', 'f.flash': '플래시 어텐션',
  'opt.f16': 'f16 (기본)',
  'u.cnt': '개', 'u.case': '건',
  'keep.unlimited': '무제한', 'keep.min': '{n}분', 'keep.hour': '{n}시간', 'keep.day': '{n}일',
  'exp.none': '만료 없음', 'exp.at': '{t} 만료',
  'gpu.auto': '자동', 'gpu.n': 'GPU {g} · {name}',

  'state.running': '실행 중', 'state.stopped': '중지됨', 'state.starting': '시작 중', 'state.unreachable': '응답 없음',

  'new.title': '새 인스턴스', 'new.server': '서버', 'new.general': '일반', 'new.advanced': '고급',
  'new.generalT': '일반 펼치기/숨기기', 'new.advancedT': '고급 펼치기/숨기기',
  'new.modelsHint': '하나 이상 골라야 합니다. 고른 모델 외의 요청은 거절합니다.', 'd.allowedHint': '비워 두면 설치된 모든 모델을 씁니다. 고른 모델 외의 요청은 거절합니다.', 'v.models.t': '허용 모델 선택', 'v.models.m': '허용 모델을 하나 이상 골라야 합니다.', 'd.allowed': '허용 모델', 'd.allowedSave': '적용',
  'new.models': '허용 모델', 'new.toggle': '{n} 펼치기/숨기기', 'new.noModels': '다운로드된 모델이 없습니다',

  'log.all': '전체', 'log.app': '앱',
  'ext.name': '기본 인스턴스', 'ext.managed': '외부 관리',
  'card.none': '로드된 모델 없음', 'card.line': '포트 {port} · 컨텍스트 {ctx} · VRAM {gb} GB',

  'sum.ins': '인스턴스', 'sum.usage': '사용량', 'sum.perf': '성능', 'sum.status': '상태',
  'sum.empty': '표시할 항목이 없습니다.',
  'c.total': '전체', 'c.running': '실행 중', 'c.stopped': '중지', 'c.unreach': '응답 없음',
  'c.mem': '메모리', 'c.models': '로드 모델', 'c.reqs': '처리 중 요청', 'c.queued': '대기', 'c.latency': '평균 응답',
  'c.speed': '평균 속도', 'c.warn': '경고', 'c.ok': '정상', 'c.errs': '최근 오류',
  'c.mon': '웹 접속', 'c.on': '켬', 'c.off': '끔', 'c.updated': '갱신',

  'mon.cpu': '{pct}% · {n} 코어', 'mon.system': '시스템', 'mon.other': '기타', 'mon.gpus': '{n}개',

  'd.pid': 'PID', 'd.uptime': '가동 시간', 'd.up': '2시간 14분', 'd.none': '없음', 'd.models': '모델',
  'd.loaded': '로드된 모델', 'd.avail': '사용 가능 모델', 'd.res': '리소스', 'd.vram': 'VRAM 사용량',
  'd.reqs': '요청 처리', 'd.reqsV': '{n}건 처리 중',

  'set.title': '환경설정', 'set.general': '일반', 'set.login': '시스템 시작 시 자동 실행',
  'set.tray': '트레이로 최소화', 'set.lang': '언어', 'set.theme': '테마',
  'theme.system': '시스템', 'theme.light': '라이트', 'theme.dark': '다크',
  'set.monitor': '모니터', 'set.ext': '웹 접속', 'set.extPort': '웹 접속 포트',
  'set.interval': '상태 갱신 주기', 'sec.n': '{n}초',
  'set.exe': '올라마 실행 파일', 'set.exePh': '비워두면 자동 탐색', 'set.browse': '찾아보기',
  'set.models': '모델 경로 (OLLAMA_MODELS 기본값)', 'set.update': '업데이트',
  'set.ver': '현재 버전 {v}', 'set.check': '업데이트 확인', 'set.checking': '확인 중…',
  'set.reset': '기본설정', 'set.save': '저장',

  'upd.title': '업데이트 확인', 'upd.latest': '최신 버전입니다. ({v})',
  'rst.title': '환경설정 초기화', 'rst.msg': '모든 환경설정을 기본값으로 되돌리고 저장합니다.', 'rst.ok': '초기화',
  'port.conflict': '포트 충돌',
  'sv.portMsg': '웹 접속 포트 {p}은(는) 인스턴스가 사용 중입니다.\n다른 포트를 지정하세요.',
  'ext.title': '웹 접속', 'ext.msg': '웹 접속 서버가 포트 {p}으로 다시 시작됩니다.',
  'rr.t': '재시작 필요', 'rr.m': '새 실행 파일 또는 모델 경로를 적용하려면 실행 중인 인스턴스를 재시작해야 합니다.',

  'mdl.param': '파라미터 {p} · 양자화 {q}', 'mdl.estimate': '현재 환경 기준 추정치',
  'mdl.library': '라이브러리', 'mdl.none': '설치된 모델이 없습니다.', 'mdl.stats': '{path} · 모델 {n}개 · 총 {gb} GB',
  'mdl.download': '다운로드', 'mdl.dlPh': '다운로드할 모델 (예: qwen3:8b-q4_K_M)',
  'mdl.dup.title': '이미 설치된 모델', 'mdl.dup.msg': '{n} 모델은 이미 설치되어 있습니다.',
  'mdl.empty.title': '모델 이름 필요', 'mdl.empty.msg': '다운로드할 모델 이름을 입력하세요.',
  'btn.pause': '중지', 'btn.resume': '재개', 'mdl.paused': '중지됨', 'mdl.failed': '오류',
  'mdl.dl.del.title': '다운로드 삭제', 'mdl.dl.del.msg': '{n} 다운로드를 중단하고 받은 파일을 지웁니다.',
  'mdl.del.title': '모델 삭제', 'mdl.del.msg': '{n} 파일을 삭제합니다.',
  'mdl.del.used': '사용 중인 인스턴스({u})에서도 쓸 수 없게 됩니다.',

  'inst.del.title': '인스턴스 삭제',
  'inst.del.msg': '{n} 인스턴스를 삭제합니다.\n삭제하면 먼저 종료되며, 모델 파일은 삭제되지 않습니다.',

  'v.nameReq.t': '이름 필요', 'v.nameReq.m': '인스턴스 이름을 입력하세요.',
  'v.nameDup.t': '이름 중복', 'v.nameDup.m': '{n} 이름은 이미 사용 중입니다.',
  'v.port.t': '포트 오류', 'v.port.m': '포트는 1024~65535 사이여야 합니다.',
  'v.used.m': '포트 {p}은(는) 이미 사용 중입니다.',

  'w.vram.t': 'VRAM 부족 주의',
  'w.vram.m': '현재 VRAM 사용률이 {pct}%입니다.\n{n}을(를) 시작해 모델을 로드하면 다른 인스턴스의 모델이 내려가거나 로드에 실패할 수 있습니다.',
  'w.stop.t': '인스턴스 종료',
  'w.stop.m': '{n}을(를) 종료합니다.\n로드된 모델 {k}개가 내려가고, 처리 중인 요청은 중단됩니다.',
  'd.req': '요청', 'c.fail': '실패',
  'rq.byModel': '모델별 (최근 5분)', 'rq.recent': '최근 요청', 'rq.none': '아직 요청이 없습니다.',
  'rq.model': '모델', 'rq.count': '요청', 'rq.speed': '속도', 'rq.avg': '평균 응답',
  'rq.time': '시각', 'rq.path': '경로', 'rq.status': '상태', 'rq.dur': '소요', 'rq.tok': '토큰 (입력/출력)', 'rq.cancelled': '취소',
  'rq.hour': '최근 1시간 요청 {n}건', 'rq.hourSpeed': '최근 1시간 속도 (최대 {n} tok/s)',
  'f.lan': 'LAN에서 접속 허용', 'f.key': 'API 키', 'f.keyPh': '비워 두면 인증하지 않습니다', 'btn.genKey': '생성', 'd.addr': '접속 주소',
  'w.lan.t': '인증 없이 네트워크에 공개', 'w.lan.m': '이 인스턴스는 같은 네트워크의 모든 기기에서 인증 없이 쓸 수 있게 됩니다. API 키를 설정하는 것을 권장합니다.', 'btn.open': '공개',
  'f.auto': '요청이 오면 자동 시작', 'f.idle': '유휴 시 자동 중지 (분, 0 = 안 함)', 'card.auto': '요청이 오면 자동 시작', 'auto.idle': '켬 · 유휴 {n}분 후 중지',
  'set.extHint': '켜면 아래 포트의 주소를 브라우저로 열어 이 화면을 읽기 전용(게스트)으로 볼 수 있습니다. 로그인이 없으므로 신뢰하는 네트워크에서만 켜세요.', 'guest.badge': '읽기 전용',
  'boot.loading': '불러오는 중…',
  'w.busy.t': '처리 중인 요청이 있습니다',
  'w.busy.m': '{n}에서 요청 {k}개를 처리하는 중입니다.\n끝날 때까지 기다린 뒤 중지하거나, 지금 바로 중지할 수 있습니다. 바로 중지하면 처리 중인 응답이 끊깁니다.',
  'btn.drainStop': '끝나면 중지', 'btn.stopNow': '바로 중지',
  'w.fit.t': 'VRAM 부족 가능',
  'w.fit.m': '동시에 로드될 모델이 약 {need} GB로, 선택한 장치의 사용 가능 VRAM({cap} GB)을 넘습니다.\n그래도 생성할까요?',

  'state.stopping': '중지 중', 'state.crashed': '비정상 종료',
  'err.title': '작업에 실패했습니다', 'conn.lost': '백엔드와의 연결이 끊어졌습니다. 다시 연결하는 중…',
  'up.h': '시간', 'up.m': '분'
};

export default ko;
