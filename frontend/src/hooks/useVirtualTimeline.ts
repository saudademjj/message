import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefCallback,
  type RefObject,
} from 'react';
import type { TimelineItem } from './useTimelineItems';

type VirtualMeasurement<TMessage> = {
  item: TimelineItem<TMessage>;
  index: number;
  size: number;
  start: number;
  end: number;
};

type UseVirtualTimelineOptions<TMessage> = {
  items: TimelineItem<TMessage>[];
  containerRef: RefObject<HTMLElement | null>;
  estimateSize: (item: TimelineItem<TMessage>) => number;
  overscanPx?: number;
};

type ScrollAlign = 'start' | 'center' | 'end';

function lowerBound<TMessage>(
  measurements: VirtualMeasurement<TMessage>[],
  targetOffset: number,
): number {
  let left = 0;
  let right = measurements.length - 1;
  let answer = 0;
  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    if (measurements[middle].end < targetOffset) {
      left = middle + 1;
      answer = left;
    } else {
      answer = middle;
      right = middle - 1;
    }
  }
  return Math.max(0, Math.min(answer, measurements.length - 1));
}

export function useVirtualTimeline<TMessage>({
  items,
  containerRef,
  estimateSize,
  overscanPx = 480,
}: UseVirtualTimelineOptions<TMessage>) {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [measuredHeights, setMeasuredHeights] = useState<Map<string, number>>(() => new Map());
  const resizeObserversRef = useRef<Map<string, ResizeObserver>>(new Map());
  const refCallbacksRef = useRef<Map<string, RefCallback<HTMLDivElement>>>(new Map());
  const rafIdRef = useRef<number | null>(null);
  const latestScrollRef = useRef(0);

  // RAF-throttled scroll state update to prevent re-render cascades
  const throttledSetScrollTop = useCallback((value: number) => {
    latestScrollRef.current = value;
    if (rafIdRef.current !== null) {
      return;
    }
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      setScrollTop(latestScrollRef.current);
    });
  }, []);

  const setMeasuredHeight = useCallback((key: string, nextHeight: number) => {
    const normalizedHeight = Math.max(24, Math.ceil(nextHeight));
    setMeasuredHeights((previous) => {
      if (previous.get(key) === normalizedHeight) {
        return previous;
      }
      const next = new Map(previous);
      next.set(key, normalizedHeight);
      return next;
    });
  }, []);

  const measureNode = useCallback((key: string, node: HTMLDivElement | null) => {
    const existing = resizeObserversRef.current.get(key);
    if (existing) {
      existing.disconnect();
      resizeObserversRef.current.delete(key);
    }

    if (!node) {
      return;
    }

    const readHeight = () => {
      setMeasuredHeight(key, node.getBoundingClientRect().height);
    };
    readHeight();

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        readHeight();
      });
      observer.observe(node);
      resizeObserversRef.current.set(key, observer);
    }
  }, [setMeasuredHeight]);

  const getMeasureRef = useCallback((key: string): RefCallback<HTMLDivElement> => {
    const cached = refCallbacksRef.current.get(key);
    if (cached) {
      return cached;
    }
    const callback: RefCallback<HTMLDivElement> = (node) => {
      measureNode(key, node);
    };
    refCallbacksRef.current.set(key, callback);
    return callback;
  }, [measureNode]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    setViewportHeight(container.clientHeight);
    setScrollTop(container.scrollTop);

    if (typeof ResizeObserver === 'undefined') {
      const onResize = () => {
        setViewportHeight(container.clientHeight);
      };
      window.addEventListener('resize', onResize);
      return () => {
        window.removeEventListener('resize', onResize);
      };
    }

    const observer = new ResizeObserver(() => {
      setViewportHeight(container.clientHeight);
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [containerRef]);

  useEffect(() => {
    const observers = resizeObserversRef.current;
    const callbacks = refCallbacksRef.current;
    return () => {
      for (const observer of observers.values()) {
        observer.disconnect();
      }
      observers.clear();
      callbacks.clear();
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, []);

  const measurements = useMemo(() => {
    const result: VirtualMeasurement<TMessage>[] = [];
    let offset = 0;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const size = measuredHeights.get(item.key) ?? estimateSize(item);
      const start = offset;
      const end = start + size;
      result.push({
        item,
        index,
        size,
        start,
        end,
      });
      offset = end;
    }
    return result;
  }, [estimateSize, items, measuredHeights]);

  const totalHeight = measurements.length > 0
    ? measurements[measurements.length - 1].end
    : 0;

  const visibleRange = useMemo(() => {
    if (measurements.length === 0) {
      return { startIndex: 0, endIndex: -1 };
    }
    const windowStart = Math.max(0, scrollTop - overscanPx);
    const windowEnd = scrollTop + Math.max(viewportHeight, 1) + overscanPx;
    const startIndex = lowerBound(measurements, windowStart);
    let endIndex = startIndex;
    while (
      endIndex < measurements.length &&
      measurements[endIndex].start <= windowEnd
    ) {
      endIndex += 1;
    }
    endIndex = Math.max(startIndex, endIndex - 1);
    return { startIndex, endIndex };
  }, [measurements, overscanPx, scrollTop, viewportHeight]);

  const virtualItems = useMemo(() => {
    if (visibleRange.endIndex < visibleRange.startIndex) {
      return [] as VirtualMeasurement<TMessage>[];
    }
    return measurements.slice(visibleRange.startIndex, visibleRange.endIndex + 1);
  }, [measurements, visibleRange.endIndex, visibleRange.startIndex]);

  const paddingTop = virtualItems[0]?.start ?? 0;
  const paddingBottom = Math.max(0, totalHeight - (virtualItems[virtualItems.length - 1]?.end ?? 0));

  const scrollToKey = useCallback((key: string, align: ScrollAlign = 'center') => {
    const container = containerRef.current;
    if (!container) {
      return false;
    }
    const target = measurements.find((item) => item.item.key === key);
    if (!target) {
      return false;
    }
    let nextTop = target.start;
    if (align === 'center') {
      nextTop = target.start - Math.max(0, (container.clientHeight - target.size) / 2);
    } else if (align === 'end') {
      nextTop = target.end - container.clientHeight;
    }
    const normalizedTop = Math.max(0, Math.round(nextTop));
    container.scrollTo({ top: normalizedTop, behavior: 'smooth' });
    setScrollTop(normalizedTop);
    return true;
  }, [containerRef, measurements]);

  return {
    setScrollTop: throttledSetScrollTop,
    getMeasureRef,
    scrollToKey,
    virtualItems,
    paddingTop,
    paddingBottom,
    totalHeight,
  };
}
