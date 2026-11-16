# 데모 음성 샘플 (20개)

대화 인식 데모를 위해 YouTube 공개 영상에서 **일부 구간(각 35초)** 을 추출한 음성 샘플입니다.

- 형식: WAV, PCM s16le, 16kHz, mono (`wav_pcm_s16le`)
- 용도: 로컬 데모/업로드·분석 흐름 확인용 샘플 (학습/재배포 목적 아님)
- 주의: 각 음원의 저작권은 원저작자/채널에 있습니다. 원본 출처 URL과 제목을 아래에 명시합니다. 상업적 이용·재배포 전 각 영상의 라이선스/이용 조건을 확인하세요.

## 샘플 목록

| 파일 | 구간(초) | 원본 제목 | 출처 |
| --- | ---: | --- | --- |
| `01_hyunbin_sonyejin_interview.wav` | 60–95 | 현빈·손예진 인터뷰를 통해 배우는 한국어 대화 | https://www.youtube.com/watch?v=__YWexRzHnA |
| `02_jackson_henry_mixed_talk.wav` | 10–45 | 잭슨·헨리 중국어+영어+한국어 대화 (냉장고를 부탁해 103회) | https://www.youtube.com/watch?v=BWq_hgrIRao |
| `03_sunwoo_yongyeo_interview.wav` | 180–215 | "딱 보면 답 나와요." 데뷔 60년차 배우 인터뷰 (선우용여 1부) | https://www.youtube.com/watch?v=54LzbBE-75s |
| `04_korean_american_kids_talk.wav` | 30–65 | 한국아이가 미국아이를 처음 만나면 하는 말 (ODG) | https://www.youtube.com/watch?v=r1gp8Qx5YPQ |
| `05_park_jaeyeon_interview.wav` | 120–155 | 상대방의 불편한 말에 대처하는 법 인터뷰 | https://www.youtube.com/watch?v=ECwQAke6_IQ |
| `06_pr_career_talk.wav` | 60–95 | 커뮤니케이션 PR회사 커리어 토크 (3년차·10년차) | https://www.youtube.com/watch?v=G38oSJjk5sk |
| `07_korean_real_talking_interview.wav` | 120–155 | 【한국어 말하기】 지인 인터뷰-2, 반말/개인적인 이야기 (A Piece Of Korean) | https://www.youtube.com/watch?v=cSwaRkus1q4 |
| `08_elementary_students_debate.wav` | 60–95 | 초등학생들의 빵터지는 토론 대결 | https://www.youtube.com/watch?v=mOrgXbvAvFk |
| `09_akmu_sibling_talk.wav` | 120–155 | AKMU 남매 대화 (모두의 남매 뭐든 해 EP.5) | https://www.youtube.com/watch?v=mdorfPpv-Zs |
| `10_minsang_toron_dialogue.wav` | 180–215 | 민상토론: 저는 이 코너와 맞지 않는 것 같습니다 (KBS) | https://www.youtube.com/watch?v=7XSVJ4Q-SII |
| `11_professors_prank_dialogue.wav` | 60–95 | 교양있는 교수들이 옆에서 유치한 싸움을 벌이고 있다면? (몰카) | https://www.youtube.com/watch?v=PZ-mRawurww |
| `12_friends_argument_dialogue.wav` | 30–65 | 친구 데리고 따지러 온 전 영상 빌런녀 | https://www.youtube.com/watch?v=eRs_1pzPOF0 |
| `13_two_friends_restaurant_convo.wav` | 30–65 | 두 친구 식당 대화(반복듣기) | https://www.youtube.com/watch?v=WH8TUzhnIIo |
| `14_real_korean_conversation_hoon.wav` | 90–125 | Real Korean Conversation with Hoon | https://www.youtube.com/watch?v=d8e9z5cxSQw |
| `15_natural_korean_conversation_1h.wav` | 300–335 | 1 HOUR Natural Korean Conversation - Listening Practice | https://www.youtube.com/watch?v=6Y7VwFR5cDg |
| `16_natural_korean_conversation_taewoong.wav` | 180–215 | Natural Korean Conversation with 태웅쌤 | https://www.youtube.com/watch?v=Ux-TMWnmntM |
| `17_korean_conversation_john.wav` | 300–335 | Korean Conversation with John | https://www.youtube.com/watch?v=8oL03cm1kMc |
| `18_korean_food_podcast_talk.wav` | 300–335 | 한국인이 사랑하는 음식 이야기 (Korean Food Stories) Podcast | https://www.youtube.com/watch?v=V_v8JJQLPz0 |
| `19_yuquiz_conversation_tips_talk.wav` | 120–155 | 유퀴즈온더블럭: 성공적인 대화법 토크 | https://www.youtube.com/watch?v=rEDtfehBzIs |
| `20_runningman_voice_debate.wav` | 60–95 | 런닝맨: 논리보다 목소리가 더 중요한 토론 | https://www.youtube.com/watch?v=DddjWGZKgqo |

## 추출/변환

`yt-dlp` + `ffmpeg`로 오디오 구간을 내려받아 16kHz mono PCM WAV로 변환했습니다.

```bash
yt-dlp -f "ba/bestaudio/best" --download-sections "*START-END" -o "tmp.%(ext)s" "<URL>"
ffmpeg -i tmp.* -ar 16000 -ac 1 -c:a pcm_s16le out.wav
```
