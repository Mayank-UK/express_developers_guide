export function PageNotFoundView() {
  return (
    <section className="mx-auto flex w-full max-w-content flex-col items-center gap-sm px-md py-xl text-center">
      <h1 className="font-display text-display-sm text-on-surface">Page not found</h1>
      <p className="text-body text-on-surface-variant">
        The page you are looking for does not exist.
      </p>
    </section>
  );
}
