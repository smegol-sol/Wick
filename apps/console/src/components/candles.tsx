import type { Candle } from "@wick/core/api";
import { CandlestickSeries, ColorType, createChart, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";

export function Candles({ candles, height = 220 }: { candles: Candle[]; height?: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || candles.length === 0) return;
    const styles = getComputedStyle(document.documentElement);
    const color = (name: string) => styles.getPropertyValue(name).trim();
    const chart = createChart(el, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: color("--color-muted") || "#8b8b84",
        fontFamily: color("--font-mono") || "monospace",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: "rgba(236,236,232,0.06)" } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { horzLine: { visible: false } },
      handleScroll: {
        pressedMouseMove: true,
        mouseWheel: false,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: false },
    });
    const up = color("--color-up") || "#7dcfb6";
    const down = color("--color-down") || "#c46b5a";
    const series = chart.addSeries(CandlestickSeries, {
      upColor: up,
      downColor: down,
      borderVisible: false,
      wickUpColor: up,
      wickDownColor: down,
      priceFormat: { type: "price", precision: 8, minMove: 0.00000001 },
    });
    series.setData(
      candles.map((c) => ({
        time: Math.floor(c.t / 1000) as UTCTimestamp,
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
      })),
    );
    chart.timeScale().fitContent();
    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [candles, height]);
  if (candles.length === 0)
    return <div className="px-4 py-6 text-center text-sm text-muted">n/a</div>;
  return <div ref={ref} className="w-full" style={{ height }} />;
}
