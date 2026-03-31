import { ImageResponse } from "next/og";

export const size = {
  width: 180,
  height: 180,
};

export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%)",
          color: "white",
          fontSize: 96,
          fontWeight: 800,
          borderRadius: 36,
          letterSpacing: "-0.08em",
        }}
      >
        G1
      </div>
    ),
    {
      ...size,
    },
  );
}
