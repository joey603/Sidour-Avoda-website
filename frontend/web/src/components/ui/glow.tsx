import React from "react";
import { cn } from "@/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";

const glowVariants = cva("pointer-events-none absolute w-full", {
  variants: {
    variant: {
      top: "top-0",
      center: "top-1/2 -translate-y-1/2",
      bottom: "bottom-0",
    },
  },
  defaultVariants: { variant: "top" },
});

const Glow = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof glowVariants>
>(({ className, variant, ...props }, ref) => (
  <div ref={ref} className={cn(glowVariants({ variant }), className)} {...props}>
    <div className="absolute left-1/2 h-[256px] w-[60%] -translate-x-1/2 scale-[2.5] rounded-[50%] sm:h-[512px]"
      style={{ background: "radial-gradient(ellipse at center, rgba(0,168,224,0.35) 10%, rgba(0,168,224,0) 60%)" }} />
    <div className="absolute left-1/2 h-[128px] w-[40%] -translate-x-1/2 scale-[2] rounded-[50%] sm:h-[256px]"
      style={{ background: "radial-gradient(ellipse at center, rgba(0,168,224,0.2) 10%, rgba(0,168,224,0) 60%)" }} />
  </div>
));
Glow.displayName = "Glow";

export { Glow };
