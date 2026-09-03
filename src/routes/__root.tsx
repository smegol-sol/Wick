import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { DeskShell } from "@/components/desk-shell";
import { MarketProvider } from "@/components/market-provider";
import appCss from "../styles.css?url";

const APP_NAME = "WICK";
const DESCRIPTION = "WICK. Solana meme spot desk. Live pulse, on-chain audit, self-custodied execution.";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: APP_NAME },
      { name: "theme-color", content: "#0a0b0c" },
      { name: "description", content: DESCRIPTION },
      { name: "referrer", content: "no-referrer" },
      { property: "og:title", content: APP_NAME },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:image", content: "/og.jpg" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/icon-180.png" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap",
      },
    ],
  }),
  component: () => (
    <html lang="en" suppressHydrationWarning className="antialiased">
      <head>
        <HeadContent />
      </head>
      <body>
        <MarketProvider>
          <DeskShell>
            <Outlet />
          </DeskShell>
        </MarketProvider>
        <Scripts />
      </body>
    </html>
  ),
});
