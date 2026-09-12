import { ImageResponse } from "next/og";

export const alt = "Interview Pack｜技术岗面试作战包";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        alignItems: "stretch",
        background: "#f7faff",
        color: "#102a43",
        display: "flex",
        height: "100%",
        padding: "58px 68px",
        position: "relative",
        width: "100%",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          width: "59%",
        }}
      >
        <div
          style={{
            color: "#1463f3",
            display: "flex",
            fontSize: 26,
            fontWeight: 700,
            letterSpacing: 2,
          }}
        >
          INTERVIEW PACK
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <div
            style={{
              display: "flex",
              fontSize: 66,
              fontWeight: 800,
              letterSpacing: -3,
              lineHeight: 1.08,
            }}
          >
            技术岗面试作战包
          </div>
          <div style={{ color: "#526c8a", display: "flex", fontSize: 29, lineHeight: 1.4 }}>
            基于 JD、简历与轮次，定向准备一场面试。
          </div>
        </div>
        <div style={{ color: "#1463f3", display: "flex", fontSize: 28, fontWeight: 700 }}>
          5 分钟开始准备
        </div>
      </div>
      <div
        style={{
          background: "#ffffff",
          border: "2px solid #d7e2ef",
          boxShadow: "16px 16px 0 #dbeafe",
          display: "flex",
          flexDirection: "column",
          gap: 24,
          marginLeft: 42,
          padding: "34px 30px",
          width: "41%",
        }}
      >
        <div
          style={{
            borderBottom: "2px solid #d7e2ef",
            color: "#1463f3",
            display: "flex",
            fontSize: 21,
            fontWeight: 700,
            paddingBottom: 20,
          }}
        >
          INTERVIEW PREP
        </div>
        {["高频面试题", "参考回答要点", "追问与延伸"].map((item, index) => (
          <div
            key={item}
            style={{
              alignItems: "center",
              display: "flex",
              fontSize: 25,
              fontWeight: 700,
              gap: 14,
            }}
          >
            <div
              style={{
                alignItems: "center",
                background: "#1463f3",
                borderRadius: 999,
                color: "#ffffff",
                display: "flex",
                fontSize: 18,
                height: 34,
                justifyContent: "center",
                width: 34,
              }}
            >
              {index + 1}
            </div>
            {item}
          </div>
        ))}
      </div>
    </div>,
    size,
  );
}
