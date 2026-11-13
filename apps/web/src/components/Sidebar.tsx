import type { Person } from "../api/client.ts";

interface SidebarProps {
  query: string;
  onQueryChange(value: string): void;
  people: Person[];
  peopleState: "loading" | "ready" | "error";
  activePersonId: string | null;
  onPersonChange(personId: string | null): void;
  onRetryPeople(): void;
}

export function Sidebar({
  query,
  onQueryChange,
  people,
  peopleState,
  activePersonId,
  onPersonChange,
  onRetryPeople,
}: SidebarProps) {
  return (
    <aside className="sidebar" aria-label="찾아보기">
      <div className="field">
        <label className="field__label" htmlFor="search">
          검색
        </label>
        <input
          id="search"
          className="field__input"
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="장소, 대화 내용"
          autoComplete="off"
          spellCheck={false}
        />
        <p className="field__hint">대화 본문과 요약에서 찾습니다.</p>
      </div>

      <section className="people" aria-labelledby="people-heading">
        <h2 className="people__heading" id="people-heading">
          사람
        </h2>

        {peopleState === "loading" && <p className="muted">불러오는 중…</p>}

        {peopleState === "error" && (
          <div className="inline-error">
            <p>사람 목록을 불러오지 못했습니다.</p>
            <button className="text-button" type="button" onClick={onRetryPeople}>
              다시 시도
            </button>
          </div>
        )}

        {peopleState === "ready" && people.length === 0 && (
          <p className="muted">아직 식별된 사람이 없습니다.</p>
        )}

        {peopleState === "ready" && people.length > 0 && (
          <ul className="people__list">
            <li>
              <button
                type="button"
                className="person"
                aria-pressed={activePersonId === null}
                onClick={() => onPersonChange(null)}
              >
                모두
              </button>
            </li>
            {people.map((person) => (
              <li key={person.id}>
                <button
                  type="button"
                  className="person"
                  aria-pressed={activePersonId === person.id}
                  onClick={() => onPersonChange(person.id)}
                >
                  {person.displayName}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="sidebar__note">
        로컬 임시 인증으로 연결되어 있습니다. 서버 세션 인증은 준비됐고, 웹 로그인은 Apple Service ID 발급 후 연결합니다.
      </p>
    </aside>
  );
}
