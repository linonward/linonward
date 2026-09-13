export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="shell site-footer__inner">
        <p className="wordmark">
          <span>LinOnward</span> <span className="wordmark__accent">Skills</span>
        </p>
        <p>更好的工程判断，更踏实的每一次行动。</p>
        <p>
          <a href="https://github.com/linonward/skills" target="_blank" rel="noreferrer">
            GitHub
          </a>
          <span aria-hidden="true"> · </span>
          MIT License
        </p>
      </div>
    </footer>
  );
}
