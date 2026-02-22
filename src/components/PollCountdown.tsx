interface PollCountdownProps {
  remaining: number;
  total: number;
  isPolling: boolean;
  size?: number;
}

export function PollCountdown({
  remaining,
  total,
  isPolling,
  size = 18,
}: PollCountdownProps) {
  const progress = total > 0 ? 1 - remaining / total : 0;
  const strokeWidth = 1.5;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - progress);

  return (
    <div
      className="group relative flex items-center justify-center opacity-40 hover:opacity-60 transition-opacity"
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        className={`-rotate-90 ${isPolling ? "animate-spin" : ""}`}
        style={{ animationDuration: "1s" }}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          className="text-text-muted opacity-30"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={isPolling ? circumference * 0.75 : strokeDashoffset}
          strokeLinecap="round"
          className="text-text-secondary transition-all duration-100"
        />
      </svg>
      <span className="absolute top-full left-1/2 -translate-x-1/2 mt-1.5 px-2 py-1 bg-surface-alt text-text-primary text-[10px] rounded whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none shadow-lg border border-border z-50">
        {isPolling ? "Syncing..." : `Next sync in ${Math.ceil(remaining / 1000)}s`}
      </span>
    </div>
  );
}
