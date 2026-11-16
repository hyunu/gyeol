#!/usr/bin/env node
/**
 * 로컬(데모) AI Provider — GYEOL AI HTTP 계약(/v1/analyze, /v1/embed) 구현.
 *
 * 목적: 외부 STT/LLM provider 없이도 검증 웹앱에서 샘플별 텍스트·요약·화자분리
 * 결과가 다르게 표시되도록 한다. demo/audio-samples 의 각 WAV(sha256 기준)에
 * 대해 사전 정의된 분석 결과를 반환하고, 미등록 오디오에는 범용 결과를 생성한다.
 *
 * 실행: node scripts/local-ai-provider.mjs  (기본 8787)
 * 연동: GYEOL_AI=http AI_PROVIDER_URL=http://127.0.0.1:8787 npm start
 */
import http from "node:http";
import { createHash } from "node:crypto";

const PORT = Number(process.env.LOCAL_AI_PORT ?? process.env.PORT ?? 8787);
const DIM = 768;

// ---------- embedding (fake-pipeline 과 동일한 트라이그램 해싱, 결정적) ----------
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}
function embed(text, dim = DIM) {
  const v = new Array(dim).fill(0);
  const normalized = String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  for (let i = 0; i + 2 < normalized.length; i += 1) v[fnv1a(normalized.slice(i, i + 3)) % dim] += 1;
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

// ---------- per-sample curated results (sha256 -> content) ----------
function seg(text, speakerLabel, startMs, endMs, confidence = 0.9) {
  return { seq: 0, startMs, endMs, text, speakerLabel, confidence };
}
function withSeq(arr) { return arr.map((s, i) => ({ ...s, seq: i })); }

const SAMPLES = {
  "309d233a4e81f0e178109d20ad78d2bb23cd4b3d1e30d9593cea10925cf71ca6": {
    title: "현빈·손예진 인터뷰 대화",
    summary: "현빈과 손예진이 작품과 일상에 대한 질문에 서로의 생각을 나누며 편안한 분위기로 인터뷰를 이어간다.",
    speakers: [
      { label: "SPEAKER_1", personName: "진행자", confidence: 0.86 },
      { label: "SPEAKER_2", personName: "현빈", confidence: 0.82 },
      { label: "SPEAKER_3", personName: "손예진", confidence: 0.8 },
    ],
    segments: withSeq([
      seg("두 분이 함께 작품을 하면서 가장 기억에 남는 순간은 언제였나요?", "SPEAKER_1", 0, 11000),
      seg("촬영 현장에서 서로에게 많이 의지하게 됐던 장면들이 오래 기억에 남아요.", "SPEAKER_2", 11000, 23000),
      seg("저도 같이 준비하면서 자연스럽게 호흡이 맞았던 시간이 좋았습니다.", "SPEAKER_3", 23000, 35000),
    ]),
    entities: [{ kind: "person", value: "현빈", normalizedValue: "현빈", confidence: 0.9, segmentSeq: 1 }, { kind: "person", value: "손예진", normalizedValue: "손예진", confidence: 0.9, segmentSeq: 2 }],
  },
  "318ef6a33882e970e6fff7872ac717e7b1752b60184061b7630cda5c90ef4ccf": {
    title: "잭슨·헨리 섞어 쓰기 토크",
    summary: "잭슨과 헨리가 한국어와 영어를 섞어 가며 일상과 경험담을 가볍게 주고받는다.",
    speakers: [
      { label: "SPEAKER_1", personName: "잭슨", confidence: 0.84 },
      { label: "SPEAKER_2", personName: "헨리", confidence: 0.83 },
    ],
    segments: withSeq([
      seg("요즘 어떻게 지내? I've been really busy lately.", "SPEAKER_1", 0, 12000),
      seg("나도 그래, 근데 이렇게 이야기하니까 재미있다.", "SPEAKER_2", 12000, 24000),
      seg("맞아, 편하게 섞어서 말하니까 더 솔직해지는 것 같아.", "SPEAKER_1", 24000, 35000),
    ]),
    entities: [{ kind: "person", value: "잭슨", normalizedValue: "잭슨", confidence: 0.85, segmentSeq: 0 }, { kind: "person", value: "헨리", normalizedValue: "헨리", confidence: 0.85, segmentSeq: 1 }],
  },
  "bd6989a0a9ea509b967600e43fb7b01e7b6135d8e784dc272d34118790b06dad": {
    title: "선우용여 인터뷰 대화",
    summary: "선우용여가 연기 생활과 삶에 대한 이야기를 풀어놓고, 진행자가 경험과 소감을 질문하며 대화를 이어간다.",
    speakers: [
      { label: "SPEAKER_1", personName: "진행자", confidence: 0.85 },
      { label: "SPEAKER_2", personName: "선우용여", confidence: 0.86 },
    ],
    segments: withSeq([
      seg("오랜 연기 생활 동안 가장 힘들었던 순간은 언제였나요?", "SPEAKER_1", 0, 12000),
      seg("힘든 때도 많았지만 관객분들 덕분에 여기까지 올 수 있었죠.", "SPEAKER_2", 12000, 24000),
      seg("앞으로도 건강하게 좋은 모습 보여드리고 싶어요.", "SPEAKER_2", 24000, 35000),
    ]),
    entities: [{ kind: "person", value: "선우용여", normalizedValue: "선우용여", confidence: 0.9, segmentSeq: 1 }],
  },
  "3f91c0cf328ba887119b861ac965e1fed02427dec81bfb43bfe383ea059e7ac7": {
    title: "한국계 미국 아이들 대화",
    summary: "한국계 미국 아이들이 학교와 일상, 한국 문화에 대해 서로의 경험을 나누며 자연스럽게 대화한다.",
    speakers: [
      { label: "SPEAKER_1", personName: "아이 A", confidence: 0.78 },
      { label: "SPEAKER_2", personName: "아이 B", confidence: 0.77 },
    ],
    segments: withSeq([
      seg("너희 집에서는 한국어로 이야기해, 영어로 이야기해?", "SPEAKER_1", 0, 11000),
      seg("우리 집은 반반이야. 부모님이랑은 한국어도 많이 써.", "SPEAKER_2", 11000, 23000),
      seg("나는 학교에서는 영어 쓰고 집에서는 한국 음식 먹는 게 좋아.", "SPEAKER_1", 23000, 35000),
    ]),
    entities: [{ kind: "topic", value: "한국어와 영어 사용", normalizedValue: "bilingual", confidence: 0.75, segmentSeq: 1 }],
  },
  "ece4f9378daef963fe7b61ca226c695f7b22196c088911f4c06500004dea42af": {
    title: "박재연 인터뷰 대화",
    summary: "박재연이 자신의 일과 관심사에 대해 질문에 답하며 경험과 생각을 공유한다.",
    speakers: [
      { label: "SPEAKER_1", personName: "진행자", confidence: 0.84 },
      { label: "SPEAKER_2", personName: "박재연", confidence: 0.85 },
    ],
    segments: withSeq([
      seg("요즘 가장 집중하고 있는 일은 무엇인가요?", "SPEAKER_1", 0, 11000),
      seg("최근에는 준비하던 프로젝트를 마무리하는 데 많은 시간을 쓰고 있어요.", "SPEAKER_2", 11000, 23000),
      seg("앞으로도 배운 것들을 바탕으로 새로운 시도를 해보고 싶습니다.", "SPEAKER_2", 23000, 35000),
    ]),
    entities: [{ kind: "person", value: "박재연", normalizedValue: "박재연", confidence: 0.88, segmentSeq: 1 }],
  },
  "48470da2d1f3954b13ec8a2730adba97dc24967a10ef475c864e56ab2c2cb8f8": {
    title: "PR 커리어 토크 대화",
    summary: "PR 분야에서 일하는 경험과 커리어에 대해 이야기하며, 일의 보람과 필요한 역량을 나눈다.",
    speakers: [
      { label: "SPEAKER_1", personName: "진행자", confidence: 0.83 },
      { label: "SPEAKER_2", personName: "게스트", confidence: 0.82 },
    ],
    segments: withSeq([
      seg("PR 일을 하면서 가장 중요하다고 느끼는 점은 무엇인가요?", "SPEAKER_1", 0, 12000),
      seg("상대방의 이야기를 정확히 이해하고 진심으로 소통하는 게 가장 중요해요.", "SPEAKER_2", 12000, 24000),
      seg("커리어를 쌓으면서 다양한 경험이 큰 도움이 됐습니다.", "SPEAKER_2", 24000, 35000),
    ]),
    entities: [{ kind: "topic", value: "PR 커리어", normalizedValue: "PR career", confidence: 0.82, segmentSeq: 0 }],
  },
  "5871fd6fe1b18fa1ca24bed32414f81e6934398ee7bb0f87d5ed470b7c8f7252": {
    title: "한국어 리얼 토킹 인터뷰",
    summary: "자연스러운 한국어 대화 형식으로 인터뷰가 진행되며, 일상적인 질문과 답변이 오간다.",
    speakers: [
      { label: "SPEAKER_1", personName: "인터뷰어", confidence: 0.84 },
      { label: "SPEAKER_2", personName: "인터뷰이", confidence: 0.84 },
    ],
    segments: withSeq([
      seg("요즘 일상에서 가장 즐거운 일은 뭐예요?", "SPEAKER_1", 0, 11000),
      seg("친구들이랑 만나서 이야기하는 시간이 제일 즐거워요.", "SPEAKER_2", 11000, 23000),
      seg("그렇군요, 소소한 일상이 큰 힘이 되죠.", "SPEAKER_1", 23000, 35000),
    ]),
    entities: [{ kind: "topic", value: "일상 대화", normalizedValue: "daily talk", confidence: 0.7, segmentSeq: 1 }],
  },
  "76430dda5e2b4df94199649f8225da1e81e52ecbe3f1e92001c79d5abae16ac1": {
    title: "초등학생 토론 대화",
    summary: "초등학생들이 주어진 주제에 대해 자신의 의견을 말하고 서로의 생각을 듣는 토론을 진행한다.",
    speakers: [
      { label: "SPEAKER_1", personName: "학생 A", confidence: 0.8 },
      { label: "SPEAKER_2", personName: "학생 B", confidence: 0.79 },
      { label: "SPEAKER_3", personName: "학생 C", confidence: 0.78 },
    ],
    segments: withSeq([
      seg("저는 이 의견이 더 좋다고 생각해요. 이유는 모두에게 도움이 되기 때문이에요.", "SPEAKER_1", 0, 12000),
      seg("하지만 다른 방법도 장점이 있다고 생각합니다.", "SPEAKER_2", 12000, 24000),
      seg("두 의견을 합치면 더 좋은 해결책이 나올 것 같아요.", "SPEAKER_3", 24000, 35000),
    ]),
    entities: [{ kind: "topic", value: "토론", normalizedValue: "debate", confidence: 0.8, segmentSeq: 0 }],
  },
  "3fc28cae4c616e59b1b13c4db46a27b783ae86422ed27553b112ec937abe6719": {
    title: "AKMU 남매 토크",
    summary: "AKMU 남매가 음악과 일상에 대해 편하게 이야기를 나누며 서로의 생각을 주고받는다.",
    speakers: [
      { label: "SPEAKER_1", personName: "찬혁", confidence: 0.84 },
      { label: "SPEAKER_2", personName: "수현", confidence: 0.84 },
    ],
    segments: withSeq([
      seg("이번에 작업하면서 새로 시도해 보고 싶은 게 있었어?", "SPEAKER_1", 0, 12000),
      seg("나는 이번에는 조금 더 편안한 느낌으로 불러보고 싶었어.", "SPEAKER_2", 12000, 24000),
      seg("그러면 우리 색깔이 또 다르게 나올 것 같네.", "SPEAKER_1", 24000, 35000),
    ]),
    entities: [{ kind: "group", value: "AKMU", normalizedValue: "AKMU", confidence: 0.9, segmentSeq: 0 }],
  },
  "536a3a3794a1ea0ae83f835ec12800492c17c7d5b3dfbfa97ccdd96d82ff5bc1": {
    title: "민상토론 대화",
    summary: "참여자들이 특정 주제를 놓고 찬반 의견을 나누며 근거를 들어 토론한다.",
    speakers: [
      { label: "SPEAKER_1", personName: "참여자 1", confidence: 0.82 },
      { label: "SPEAKER_2", personName: "참여자 2", confidence: 0.82 },
    ],
    segments: withSeq([
      seg("이 문제는 이렇게 접근하는 게 맞다고 봅니다.", "SPEAKER_1", 0, 12000),
      seg("하지만 현실적으로는 다른 어려움도 있을 수 있어요.", "SPEAKER_2", 12000, 24000),
      seg("좋은 지적이에요, 그 부분을 함께 고려해 봅시다.", "SPEAKER_1", 24000, 35000),
    ]),
    entities: [{ kind: "topic", value: "토론 주제", normalizedValue: "discussion", confidence: 0.7, segmentSeq: 0 }],
  },
  "92bc938b2b7f71a809490aeb138f81f9ca31445b5a578d6e4de3b92d73296187": {
    title: "교수님 몰래카메라 대화",
    summary: "교수님을 대상으로 한 몰래카메라 상황에서 등장인물들이 장난을 치고 반응을 주고받는다.",
    speakers: [
      { label: "SPEAKER_1", personName: "학생", confidence: 0.8 },
      { label: "SPEAKER_2", personName: "교수님", confidence: 0.81 },
    ],
    segments: withSeq([
      seg("교수님, 저희가 준비한 게 있는데 잠깐만 봐주세요.", "SPEAKER_1", 0, 12000),
      seg("응? 갑자기 무슨 일이지, 뭔가 이상한데?", "SPEAKER_2", 12000, 24000),
      seg("사실은 깜짝 이벤트였습니다!", "SPEAKER_1", 24000, 35000),
    ]),
    entities: [{ kind: "event", value: "깜짝 이벤트", normalizedValue: "surprise event", confidence: 0.78, segmentSeq: 2 }],
  },
  "5853bf545dd5903f659b5ed68d1b216fb00e99f8a0c512883f179dca245a7698": {
    title: "친구들 말다툼 대화",
    summary: "친구들 사이에 의견 차이로 말다툼이 생기고, 서로의 입장을 말하며 감정이 오간다.",
    speakers: [
      { label: "SPEAKER_1", personName: "친구 A", confidence: 0.79 },
      { label: "SPEAKER_2", personName: "친구 B", confidence: 0.79 },
    ],
    segments: withSeq([
      seg("아까 그건 네가 먼저 그렇게 말했잖아.", "SPEAKER_1", 0, 11000),
      seg("나는 그런 뜻이 아니었어, 오해한 거야.", "SPEAKER_2", 11000, 23000),
      seg("그럼 서로 이야기 좀 제대로 해보자.", "SPEAKER_1", 23000, 35000),
    ]),
    entities: [{ kind: "topic", value: "의견 충돌", normalizedValue: "argument", confidence: 0.74, segmentSeq: 0 }],
  },
  "f9927ad73bcfaf62b87d09785e2a7d9b083419550fa80468149f96c39a477da8": {
    title: "두 친구의 식당 대화",
    summary: "두 친구가 식당에서 메뉴를 고르고 음식을 먹으며 일상 이야기를 나눈다.",
    speakers: [
      { label: "SPEAKER_1", personName: "친구 A", confidence: 0.83 },
      { label: "SPEAKER_2", personName: "친구 B", confidence: 0.83 },
    ],
    segments: withSeq([
      seg("여기 뭐가 맛있대? 메뉴 한번 볼까?", "SPEAKER_1", 0, 11000),
      seg("이 집은 비빔밥이랑 찌개가 유명하대.", "SPEAKER_2", 11000, 23000),
      seg("좋아, 그럼 나는 비빔밥 먹을게.", "SPEAKER_1", 23000, 35000),
    ]),
    entities: [{ kind: "place", value: "식당", normalizedValue: "restaurant", confidence: 0.78, segmentSeq: 0 }, { kind: "food", value: "비빔밥", normalizedValue: "bibimbap", confidence: 0.8, segmentSeq: 2 }],
  },
  "5c189dbc4c4d333ca8169bb7013c2f2242c9d2cb1bf0c201ddd57e066fbb4841": {
    title: "훈의 리얼 한국어 대화",
    summary: "훈과 상대방이 자연스러운 한국어로 일상적인 주제에 대해 편하게 이야기한다.",
    speakers: [
      { label: "SPEAKER_1", personName: "훈", confidence: 0.84 },
      { label: "SPEAKER_2", personName: "대화 상대", confidence: 0.82 },
    ],
    segments: withSeq([
      seg("요즘 한국어 공부는 어떻게 하고 있어?", "SPEAKER_2", 0, 11000),
      seg("드라마도 보고 실제 대화도 많이 하려고 노력 중이야.", "SPEAKER_1", 11000, 23000),
      seg("그렇게 하면 표현이 훨씬 자연스러워지지.", "SPEAKER_2", 23000, 35000),
    ]),
    entities: [{ kind: "topic", value: "한국어 공부", normalizedValue: "Korean study", confidence: 0.82, segmentSeq: 1 }],
  },
  "76328803781bb4d37144954205f27097f31981f0361fa868f893a3c0a84707da": {
    title: "자연스러운 한국어 대화 (1시간 구간 샘플)",
    summary: "두 사람이 일상적인 주제로 길게 이어지는 자연스러운 한국어 대화를 나누는 구간이다.",
    speakers: [
      { label: "SPEAKER_1", personName: "화자 A", confidence: 0.82 },
      { label: "SPEAKER_2", personName: "화자 B", confidence: 0.82 },
    ],
    segments: withSeq([
      seg("요즘은 어떻게 지내? 별일 없었어?", "SPEAKER_1", 0, 11000),
      seg("응, 그냥 평소처럼 지냈어. 너는 어때?", "SPEAKER_2", 11000, 23000),
      seg("나도 이것저것 하느라 바빴는데 괜찮아.", "SPEAKER_1", 23000, 35000),
    ]),
    entities: [{ kind: "topic", value: "일상 안부", normalizedValue: "daily check-in", confidence: 0.72, segmentSeq: 0 }],
  },
  "46cc445e75cfcb994fda7d5a7ca9cebc0e11c93d01d5651590ac48d02d8de555": {
    title: "태웅의 자연스러운 한국어 대화",
    summary: "태웅과 상대방이 친근한 분위기에서 일상과 관심사에 대해 자연스럽게 대화한다.",
    speakers: [
      { label: "SPEAKER_1", personName: "태웅", confidence: 0.84 },
      { label: "SPEAKER_2", personName: "대화 상대", confidence: 0.82 },
    ],
    segments: withSeq([
      seg("최근에 재미있게 본 게 있어?", "SPEAKER_2", 0, 11000),
      seg("응, 얼마 전에 본 영상이 진짜 재미있더라.", "SPEAKER_1", 11000, 23000),
      seg("오, 나중에 나도 알려줘.", "SPEAKER_2", 23000, 35000),
    ]),
    entities: [{ kind: "person", value: "태웅", normalizedValue: "태웅", confidence: 0.86, segmentSeq: 1 }],
  },
  "c8105d84e3ebc4530061864109d4349bd0206daedd6582560d1f111e8dfd14ed": {
    title: "존과의 한국어 대화",
    summary: "존과 상대방이 한국어로 서로의 생각과 경험을 주고받으며 대화를 이어간다.",
    speakers: [
      { label: "SPEAKER_1", personName: "존", confidence: 0.83 },
      { label: "SPEAKER_2", personName: "대화 상대", confidence: 0.82 },
    ],
    segments: withSeq([
      seg("한국에서 지내면서 제일 좋았던 점이 뭐야?", "SPEAKER_2", 0, 11000),
      seg("사람들이 친절하고 음식도 다양해서 좋았어.", "SPEAKER_1", 11000, 23000),
      seg("특히 친구들이랑 같이 다닐 때가 기억에 남아.", "SPEAKER_1", 23000, 35000),
    ]),
    entities: [{ kind: "person", value: "존", normalizedValue: "존", confidence: 0.85, segmentSeq: 1 }],
  },
  "293ef8f7ef28e51ab91743a3b5bff8b258c19a24340abeee966b7cd430b21910": {
    title: "한국 음식 팟캐스트 토크",
    summary: "팟캐스트 진행자와 게스트가 한국 음식에 대한 경험과 추천 메뉴를 이야기한다.",
    speakers: [
      { label: "SPEAKER_1", personName: "진행자", confidence: 0.84 },
      { label: "SPEAKER_2", personName: "게스트", confidence: 0.83 },
    ],
    segments: withSeq([
      seg("한국 음식 중에서 요즘 가장 자주 먹는 건 뭐예요?", "SPEAKER_1", 0, 11000),
      seg("저는 요즘 집에서 김치찌개를 자주 끓여 먹어요.", "SPEAKER_2", 11000, 23000),
      seg("김치찌개는 정말 언제 먹어도 든든하죠.", "SPEAKER_1", 23000, 35000),
    ]),
    entities: [{ kind: "food", value: "김치찌개", normalizedValue: "kimchi jjigae", confidence: 0.88, segmentSeq: 1 }],
  },
  "e1239522052375232ee4471f7a08fa0150665304fba89e57bcebbed9f74c97b4": {
    title: "유퀴즈 대화 꿀팁 토크",
    summary: "대화를 잘하는 방법과 사람들과 자연스럽게 소통하는 팁에 대해 이야기한다.",
    speakers: [
      { label: "SPEAKER_1", personName: "진행자", confidence: 0.84 },
      { label: "SPEAKER_2", personName: "게스트", confidence: 0.83 },
    ],
    segments: withSeq([
      seg("대화를 자연스럽게 이어가는 비결이 있을까요?", "SPEAKER_1", 0, 11000),
      seg("상대방의 말을 잘 듣고 공감하는 게 가장 중요하다고 생각해요.", "SPEAKER_2", 11000, 23000),
      seg("작은 질문 하나가 대화를 훨씬 편하게 만들기도 하죠.", "SPEAKER_2", 23000, 35000),
    ]),
    entities: [{ kind: "topic", value: "대화 팁", normalizedValue: "conversation tips", confidence: 0.84, segmentSeq: 0 }],
  },
  "8fe2b7f97c6924a72697dd0ecc6206de67b7692a09bdb5fd88dabc9bbcc749d1": {
    title: "런닝맨 음치 논쟁 대화",
    summary: "런닝맨 멤버들이 음치 여부를 두고 장난스럽게 서로를 놀리며 논쟁한다.",
    speakers: [
      { label: "SPEAKER_1", personName: "멤버 A", confidence: 0.8 },
      { label: "SPEAKER_2", personName: "멤버 B", confidence: 0.8 },
      { label: "SPEAKER_3", personName: "멤버 C", confidence: 0.78 },
    ],
    segments: withSeq([
      seg("야, 너 진짜 음치 아니야? 방금 완전 달랐는데.", "SPEAKER_1", 0, 11000),
      seg("아니야, 일부러 그런 거라니까! 다시 들어봐.", "SPEAKER_2", 11000, 23000),
      seg("하하, 이건 논쟁이 아니라 확정인 것 같은데?", "SPEAKER_3", 23000, 35000),
    ]),
    entities: [{ kind: "show", value: "런닝맨", normalizedValue: "Running Man", confidence: 0.85, segmentSeq: 0 }],
  },
};

function fallbackResult(meta) {
  const dur = Math.max(3000, Number(meta?.recording?.durationMs) || 35000);
  const third = Math.floor(dur / 3);
  const title = "음성 대화 샘플 분석";
  const summary = "업로드된 음성 샘플에서 대화 구간을 추출해 요약하고 화자를 분리한 결과입니다. (로컬 데모 provider)";
  return {
    title, summary, language: "ko", status: "ready",
    speakers: [
      { label: "SPEAKER_1", personName: null, confidence: null },
      { label: "SPEAKER_2", personName: null, confidence: null },
    ],
    segments: withSeq([
      seg("대화 내용이 감지되었습니다. (샘플 기반 데모 텍스트)", "SPEAKER_1", 0, third),
      seg("상대방의 응답 구간으로 분리되었습니다.", "SPEAKER_2", third, third * 2),
      seg("대화가 마무리되는 구간입니다.", "SPEAKER_1", third * 2, dur),
    ]),
    entities: [],
    actionItems: [],
  };
}

function buildResult(sha256, meta) {
  const base = SAMPLES[sha256] || fallbackResult(meta);
  const textForEmbed = `${base.title} ${base.summary} ${base.segments.map(s=>s.text).join(" ")}`;
  return {
    title: base.title,
    summary: base.summary,
    language: base.language || "ko",
    status: "ready",
    speakers: base.speakers,
    segments: base.segments,
    entities: base.entities || [],
    actionItems: base.actionItems || [],
    embedding: { provider: "local-demo", model: "local-demo-embed-v1", dim: DIM, vector: embed(textForEmbed, DIM) },
    pipeline: { provider: "local-demo", model: "local-demo-v1", stages: { stt: "ok", diarization: "ok", identification: "ok", summary: "ok", extraction: "ok", embedding: "ok" } },
  };
}

// ---------- multipart parser (minimal, for metadata + audio parts) ----------
function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(contentType || "");
  if (!m) throw new Error("boundary missing");
  const boundary = m[1] || m[2];
  const sep = Buffer.from(`--${boundary}`);
  const parts = {};
  let idx = 0;
  while (true) {
    const start = buffer.indexOf(sep, idx);
    if (start === -1) break;
    let headerStart = start + sep.length;
    if (buffer.slice(headerStart, headerStart + 2).toString() === "--") break;
    if (buffer.slice(headerStart, headerStart + 2).toString() === "\r\n") headerStart += 2;
    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), headerStart);
    if (headerEnd === -1) break;
    const headers = buffer.slice(headerStart, headerEnd).toString("utf8");
    const dataStart = headerEnd + 4;
    const next = buffer.indexOf(sep, dataStart);
    let dataEnd = next === -1 ? buffer.length : next - 2; // strip \r\n
    if (dataEnd < dataStart) dataEnd = dataStart;
    const nameM = /name="([^"]+)"/i.exec(headers);
    const name = nameM ? nameM[1] : "unknown";
    parts[name] = buffer.slice(dataStart, dataEnd);
    idx = next === -1 ? buffer.length : next;
  }
  return parts;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(json) });
  res.end(json);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") {
      return send(res, 200, { status: "ok", provider: "local-demo", samples: Object.keys(SAMPLES).length });
    }
    if (req.method === "POST" && url.pathname === "/v1/embed") {
      const body = await readBody(req);
      let payload = {};
      try { payload = JSON.parse(body.toString("utf8") || "{}"); } catch {}
      const dim = Number(payload.dim) || DIM;
      return send(res, 200, { vector: embed(payload.text || "", dim) });
    }
    if (req.method === "POST" && url.pathname === "/v1/analyze") {
      const body = await readBody(req);
      const parts = parseMultipart(body, req.headers["content-type"] || "");
      let meta = {};
      try { meta = JSON.parse((parts.metadata || Buffer.alloc(0)).toString("utf8") || "{}"); } catch {}
      const audio = parts.audio || Buffer.alloc(0);
      const shaFromMeta = meta?.recording?.sha256;
      const sha = (typeof shaFromMeta === "string" && /^[0-9a-f]{64}$/.test(shaFromMeta))
        ? shaFromMeta
        : createHash("sha256").update(audio).digest("hex");
      return send(res, 200, buildResult(sha, meta));
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`local-ai-provider listening on http://127.0.0.1:${PORT} (samples=${Object.keys(SAMPLES).length})`);
});
