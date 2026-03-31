import { ImageResponse } from "next/og";

export const size = {
  width: 64,
  height: 64,
};

export const contentType = "image/png";

export default function Icon() {
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
          fontSize: 34,
          fontWeight: 800,
          borderRadius: 14,
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
