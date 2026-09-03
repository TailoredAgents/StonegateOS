import { ImageResponse } from "next/og";

export const runtime = "edge";

const size = { width: 1200, height: 630 };

export function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          padding: 64,
          background:
            "linear-gradient(135deg, #0F2536 0%, #1F3E52 62%, #0B4E41 100%)",
          color: "#ffffff",
          fontFamily: "Arial, sans-serif",
        }}
      >
        <div
          style={{
            width: "100%",
            display: "flex",
            alignItems: "stretch",
            justifyContent: "space-between",
            gap: 54,
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              maxWidth: 730,
            }}
          >
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div
                style={{
                  fontSize: 22,
                  fontWeight: 700,
                  letterSpacing: 4,
                  color: "#BFEDE2",
                  textTransform: "uppercase",
                }}
              >
                Built for partner operations
              </div>
              <div
                style={{
                  marginTop: 28,
                  fontSize: 62,
                  fontWeight: 750,
                  letterSpacing: -2.5,
                  lineHeight: 1.04,
                }}
              >
                Stonegate Partner Portal — Schedule. Coordinate. Document.
              </div>
              <div
                style={{
                  marginTop: 28,
                  fontSize: 27,
                  lineHeight: 1.35,
                  color: "#D3E0E8",
                }}
              >
                Schedule pickups, coordinate sites, and keep proof and billing
                together.
              </div>
            </div>
            <div style={{ fontSize: 20, color: "#D3E0E8" }}>
              Contractors · Real estate teams · Property managers · Commercial
              clients
            </div>
          </div>

          <div
            style={{
              width: 310,
              display: "flex",
              flexDirection: "column",
              alignSelf: "center",
              borderRadius: 28,
              padding: 22,
              background: "#F8FAFC",
              color: "#0F172A",
              boxShadow: "0 28px 60px rgba(15, 23, 42, 0.28)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                fontSize: 15,
                color: "#64748B",
              }}
            >
              <span>Property cleanout</span>
              <span
                style={{
                  borderRadius: 999,
                  padding: "7px 12px",
                  background: "#DCFCE7",
                  color: "#166534",
                  fontWeight: 700,
                }}
              >
                Completed
              </span>
            </div>
            <div style={{ marginTop: 24, fontSize: 28, fontWeight: 700 }}>
              Sample property
            </div>
            <div style={{ marginTop: 16, fontSize: 18, color: "#43697F" }}>
              Tuesday · 10 AM–12 PM
            </div>
            <div
              style={{
                marginTop: 28,
                display: "flex",
                flexDirection: "column",
                gap: 12,
                borderTop: "1px solid #E2E8F0",
                paddingTop: 20,
                fontSize: 16,
                color: "#334155",
              }}
            >
              <span>Scope and timing recorded</span>
              <span>Proof complete</span>
              <span>Completion report ready</span>
            </div>
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      headers: {
        "Cache-Control": "public, max-age=3600, s-maxage=3600",
        "Content-Disposition":
          'inline; filename="stonegate-partner-portal.png"',
      },
    },
  );
}
