interface AgentErrorBadgeProps {
  /** Number of agents currently in an error state (`status === "error"`). */
  count: number;
  /**
   * Collapsed icon-rail presentation: render a red dot on the icon instead of
   * a dot + number. The count is conveyed by the link's aria-label, so the
   * badge itself is decorative here.
   */
  rail?: boolean;
}

/** Accessible / tooltip phrase describing the error count. */
export function agentErrorLabel(count: number): string {
  return `${count} ${count === 1 ? "agent" : "agents"} in an error state, needs attention`;
}

/**
 * Red, motion-safe pulsing badge announcing how many agents are stopped in an
 * error state. Renders nothing when `count <= 0` ("no news is good news").
 *
 * Mirrors the live-count badge styling in `SidebarNavItem`, recoloured red so
 * it reads as "something bad that needs attention".
 */
export function AgentErrorBadge({ count, rail = false }: AgentErrorBadgeProps) {
  if (count <= 0) return null;

  const label = agentErrorLabel(count);

  if (rail) {
    // Decorative dot on the icon; meaning is carried by the link's aria-label.
    return (
      <span
        data-testid="sidebar-error-badge"
        aria-hidden="true"
        title={label}
        className="absolute -right-0.5 -top-0.5 flex h-2 w-2"
      >
        <span className="motion-safe:animate-pulse absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500 shadow-[0_0_0_2px_hsl(var(--background))]" />
      </span>
    );
  }

  return (
    <span
      data-testid="sidebar-error-badge"
      title={label}
      className="ml-auto flex items-center gap-1.5"
    >
      <span aria-hidden="true" className="relative flex h-2 w-2">
        <span className="motion-safe:animate-pulse absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
      </span>
      <span aria-hidden="true" className="text-[11px] font-medium text-red-600 dark:text-red-400">
        {count}
      </span>
      {/* Screen-reader text: the number above is decorative; this conveys meaning. */}
      <span className="sr-only">{label}</span>
    </span>
  );
}
