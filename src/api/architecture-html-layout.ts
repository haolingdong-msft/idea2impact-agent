export const ARCHITECTURE_IMAGE_LAYOUT_GUARD = `<style id="architecture-image-layout-guard">
html{height:100%!important;max-height:none!important;overflow:auto!important;scrollbar-gutter:stable}
body{height:auto!important;min-height:100%!important;max-height:none!important;overflow:auto!important}
[data-architecture-flow]{zoom:.72!important;width:138.8889%!important;height:auto!important;min-height:138.8889vh!important;max-height:none!important;overflow:visible!important}
[data-architecture-flow]:has(.workflow){grid-template-rows:minmax(0,1.6fr) minmax(0,1.15fr) minmax(0,.25fr)!important}
[data-architecture-flow]>*{min-height:0!important}
::-webkit-scrollbar{width:12px;height:12px}
::-webkit-scrollbar-thumb{background:#94a3b8;border:3px solid #f8fafc;border-radius:999px}
::-webkit-scrollbar-track{background:#f8fafc}
</style>`;

export function applyArchitectureImageLayoutGuard(html: string): string {
  const withoutPreviousGuard = html.replace(
    /<style\b[^>]*id=["']architecture-image-layout-guard["'][^>]*>[\s\S]*?<\/style\s*>/gi,
    "",
  );
  return /<\/head\s*>/i.test(withoutPreviousGuard)
    ? withoutPreviousGuard.replace(
        /<\/head\s*>/i,
        `${ARCHITECTURE_IMAGE_LAYOUT_GUARD}</head>`,
      )
    : withoutPreviousGuard.replace(
        /<body\b/i,
        `${ARCHITECTURE_IMAGE_LAYOUT_GUARD}<body`,
      );
}
