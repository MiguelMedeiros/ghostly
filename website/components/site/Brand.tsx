/**
 * The brand lockup, as the app draws it in its sidebar (src/components/Sidebar.tsx, `sidebar-wordmark`): the
 * app's own ghost icon and GHOSTLY in the app's system font, bold, tracked tight, both in the accent. The icon
 * is the app's path, unchanged; site.css sizes the pair in the app's proportion (text 16/28 of the icon).
 */
export function Brand() {
  return (
    <>
      <svg className="brand-icon" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
        <g transform="translate(12, 8)">
          <path
            d="M20 4C10.059 4 2 12.059 2 22v18c0 1.5 1.2 2 2 1.2l4-3.2 4 3.2c.8.6 1.6.6 2.4 0L18 38l3.6 3.2c.8.6 1.6.6 2.4 0L28 38l4 3.2c.8.8 2 .3 2-1.2V22C34 12.059 25.941 4 20 4z"
            fill="currentColor"
          />
          <circle cx="13" cy="20" r="3" fill="var(--bg, #060a10)" />
          <circle cx="27" cy="20" r="3" fill="var(--bg, #060a10)" />
        </g>
      </svg>
      <span className="brand-word">Ghostly</span>
    </>
  );
}
