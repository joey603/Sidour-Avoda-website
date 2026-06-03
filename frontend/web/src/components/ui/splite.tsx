'use client';

import { useEffect, useRef } from 'react';
import { Application } from '@splinetool/runtime';

interface SplineSceneProps {
  scene: string;
  className?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onLoad?: (app: any) => void;
}

export function SplineScene({ scene, className, onLoad }: SplineSceneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const app = new Application(canvas);
    app.load(scene).then(() => {
      onLoad?.(app);
    });

    return () => {
      app.dispose();
    };
    // onLoad intentionally omitted to avoid re-mount loop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: '100%', height: '100%' }}
    />
  );
}
