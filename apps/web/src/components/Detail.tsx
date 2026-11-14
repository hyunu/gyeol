import type { ConversationDetail } from "../api/client.ts";
import {
  dateHeading,
  dueLabel,
  durationLabel,
  segmentTime,
  timeLabel,
} from "../lib/format.ts";

interface DetailProps {
  state: "idle" | "loading" | "ready" | "error";
  detail: ConversationDetail | null;
  onBack(): void;
  onRetry(): void;
  onToggleAction(item: ConversationDetail["actionItems"][number]): void;
  pendingActionId: string | null;
  actionError: string | null;
}

const ENTITY_LABELS: Record<string, string> = {
  person: "사람",
  place: "장소",
  event: "사건",
  appointment: "약속",
  task: "할 일",
  other: "기타",
};

const TAPE_BARS = Array.from({ length: 64 }, (_, index) => {
  const value = Math.abs(Math.sin(index * 0.73) * Math.cos(index * 1.91));
  return Math.round(16 + value * 78);
});

function BackIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M13 8H4M7.5 4.5 4 8l3.5 3.5" strokeLinecap="square" />
    </svg>
  );
}

function Tape({ detail }: { detail: ConversationDetail }) {
  const spanMs = Math.max(1, ...detail.segments.map((segment) => segment.endMs));
  return (
    <div className="tape" aria-hidden="true">
      <div className="tape__bars">
        {TAPE_BARS.map((height, index) => (
          <span key={index} style={{ height: `${height}%` }} />
        ))}
      </div>
      <div className="tape__marks">
        {detail.segments.map((segment) => (
          <span
            key={segment.id}
            style={{ left: `${Math.min(100, Math.max(0, (segment.startMs / spanMs) * 100))}%` }}
          />
        ))}
      </div>
    </div>
  );
}

export function Detail({
  state,
  detail,
  onBack,
  onRetry,
  onToggleAction,
  pendingActionId,
  actionError,
}: DetailProps) {
  if (state === "idle") {
    return (
      <section className="detail detail--idle" aria-label="대화 상세">
        <div className="detail__idle-tape" aria-hidden="true">
          {TAPE_BARS.slice(0, 32).map((height, index) => (
            <span key={index} style={{ height: `${height}%` }} />
          ))}
        </div>
        <p className="eyebrow">읽기</p>
        <p className="detail__prompt">기록을 고르세요.</p>
        <p className="detail__prompt-hint">
          요약과 대화 전문, 그날의 할 일을 한 화면에서 읽습니다.
        </p>
      </section>
    );
  }

  if (state === "loading") {
    return (
      <section className="detail" aria-label="대화 상세" role="status">
        <button className="detail__back" type="button" onClick={onBack}>
          <BackIcon />
          목록으로
        </button>
        <span className="sr-only">대화를 불러오는 중입니다.</span>
        <div className="detail__skeleton">
          <span className="skeleton skeleton--meta" />
          <span className="skeleton skeleton--heading" />
          <span className="skeleton skeleton--line" />
          <span className="skeleton skeleton--line" />
        </div>
      </section>
    );
  }

  if (state === "error" || !detail) {
    return (
      <section className="detail" aria-label="대화 상세">
        <button className="detail__back" type="button" onClick={onBack}>
          <BackIcon />
          목록으로
        </button>
        <div className="panel-error" role="alert">
          <p className="panel-error__title">대화를 불러오지 못했습니다.</p>
          <p className="panel-error__body">잠시 뒤 다시 시도해 주세요.</p>
          <button className="button" type="button" onClick={onRetry}>
            다시 시도
          </button>
        </div>
      </section>
    );
  }

  const speakerById = new Map(detail.speakers.map((speaker) => [speaker.id, speaker]));
  const entitiesByKind = new Map<string, string[]>();
  for (const entity of detail.entities) {
    const list = entitiesByKind.get(entity.kind) ?? [];
    if (!list.includes(entity.value)) list.push(entity.value);
    entitiesByKind.set(entity.kind, list);
  }

  return (
    <article className="detail" aria-labelledby="detail-title">
      <button className="detail__back" type="button" onClick={onBack}>
        <BackIcon />
        목록으로
      </button>

      <header className="detail__head">
        <p className="detail__eyebrow">
          <span className="rec">REC</span>
          <span>{dateHeading(detail.startedAt)}</span>
          <span className="detail__sep" aria-hidden="true" />
          <span>{timeLabel(detail.startedAt)}</span>
          <span className="detail__sep" aria-hidden="true" />
          <span>{durationLabel(detail.startedAt, detail.endedAt)}</span>
        </p>
        <h1 className="detail__title" id="detail-title">
          {detail.title || "제목 없는 기록"}
        </h1>

        {detail.people.length > 0 && (
          <p className="detail__people">
            <span className="detail__people-label">함께한 사람</span>
            {detail.people.map((person) => (
              <span className="chip" key={person.id}>
                {person.displayName}
              </span>
            ))}
          </p>
        )}

        <Tape detail={detail} />

        {detail.summary && <p className="detail__summary">{detail.summary}</p>}
        {detail.status === "partial" && (
          <p className="detail__partial">일부 구간은 인식하지 못했습니다. 남은 기록만 보여 줍니다.</p>
        )}
      </header>

      <section className="detail__section" aria-labelledby="transcript-heading">
        <h2 className="section-title" id="transcript-heading">
          대화
        </h2>
        {detail.segments.length === 0 ? (
          <p className="muted">남아 있는 대화 구간이 없습니다.</p>
        ) : (
          <ol className="segments">
            {detail.segments.map((segment) => {
              const speaker = segment.speakerClusterId
                ? speakerById.get(segment.speakerClusterId)
                : undefined;
              const displayName = speaker?.displayName;
              const name = displayName || (speaker?.label ? `화자 ${speaker.label}` : "화자 미상");
              const avatar = displayName ? displayName.slice(0, 1) : (speaker?.label?.slice(0, 1) ?? "?");
              const unknown = !displayName;
              return (
                <li className="segment" key={segment.id}>
                  <div className="segment__meta">
                    <span className="segment__avatar" aria-hidden="true">
                      {avatar}
                    </span>
                    <span className="segment__time">{segmentTime(segment.startMs)}</span>
                  </div>
                  <div className="segment__body">
                    <span
                      className={
                        unknown ? "segment__speaker segment__speaker--unknown" : "segment__speaker"
                      }
                    >
                      {name}
                    </span>
                    <p className="segment__text">{segment.text}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {entitiesByKind.size > 0 && (
        <section className="detail__section" aria-labelledby="entities-heading">
          <h2 className="section-title" id="entities-heading">
            기억한 것
          </h2>
          <dl className="entities">
            {[...entitiesByKind.entries()].map(([kind, values]) => (
              <div className="entities__row" key={kind}>
                <dt>{ENTITY_LABELS[kind] ?? kind}</dt>
                <dd>
                  {values.map((value) => (
                    <span className="tag" key={value}>
                      {value}
                    </span>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {detail.actionItems.length > 0 && (
        <section className="detail__section" aria-labelledby="actions-heading">
          <h2 className="section-title" id="actions-heading">
            할 일
          </h2>
          {actionError && (
            <p className="inline-error" role="alert">
              {actionError}
            </p>
          )}
          <ul className="actions">
            {detail.actionItems.map((item) => {
              const done = item.status === "done";
              const pending = pendingActionId === item.id;
              const due = dueLabel(item.dueAt);
              return (
                <li className={done ? "action action--done" : "action"} key={item.id}>
                  <button
                    type="button"
                    className="action__toggle"
                    aria-label={done ? "완료 취소" : "완료로 표시"}
                    aria-pressed={done}
                    aria-busy={pending || undefined}
                    disabled={pending}
                    onClick={() => onToggleAction(item)}
                  >
                    <span className="action__box" aria-hidden="true" />
                  </button>
                  <span className="action__title">{item.title}</span>
                  {due && <span className="action__due">{due}</span>}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </article>
  );
}
