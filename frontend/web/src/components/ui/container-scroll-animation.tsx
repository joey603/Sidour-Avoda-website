"use client";

import React, { useRef } from "react";
import {
  useScroll,
  useTransform,
  motion,
  MotionValue,
} from "framer-motion";

export const ContainerScroll = ({
  titleComponent,
  children,
}: {
  titleComponent: string | React.ReactNode;
  children: React.ReactNode;
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: containerRef });
  const [isMobile, setIsMobile] = React.useState(false);

  React.useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const scaleDimensions = () => (isMobile ? [0.7, 0.9] : [1.05, 1]);

  const rotate = useTransform(scrollYProgress, [0, 1], [20, 0]);
  const scale = useTransform(scrollYProgress, [0, 1], scaleDimensions());
  const translate = useTransform(scrollYProgress, [0, 1], [0, -100]);

  return (
    <div
      className="relative flex h-[60rem] items-center justify-center p-2 md:h-[80rem] md:p-20"
      ref={containerRef}
    >
      <div
        className="relative w-full py-10 md:py-40"
        style={{ perspective: "1000px" }}
      >
        <ScrollHeader translate={translate} titleComponent={titleComponent} />
        <ScrollCard rotate={rotate} translate={translate} scale={scale}>
          {children}
        </ScrollCard>
      </div>
    </div>
  );
};

export const ScrollHeader = ({
  translate,
  titleComponent,
}: {
  translate: MotionValue<number>;
  titleComponent: string | React.ReactNode;
}) => (
  <motion.div
    style={{ translateY: translate }}
    className="mx-auto max-w-5xl text-center"
  >
    {titleComponent}
  </motion.div>
);

export const ScrollCard = ({
  rotate,
  scale,
  children,
}: {
  rotate: MotionValue<number>;
  scale: MotionValue<number>;
  translate: MotionValue<number>;
  children: React.ReactNode;
}) => (
  <motion.div
    style={{
      rotateX: rotate,
      scale,
      boxShadow:
        "0 0 #0000004d, 0 9px 20px #0000004a, 0 37px 37px #00000042, 0 84px 50px #00000026, 0 149px 60px #0000000a, 0 233px 65px #00000003",
    }}
    className="mx-auto -mt-12 h-[30rem] w-full max-w-5xl rounded-[30px] border-4 border-[#6C6C6C] bg-[#222222] p-2 shadow-2xl md:h-[40rem] md:p-6"
  >
    <div className="h-full w-full overflow-hidden rounded-2xl bg-zinc-900">
      {children}
    </div>
  </motion.div>
);
