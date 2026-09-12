import { describe, expect, it } from "vitest";

import { imagePresentation, safeImageFilter } from "./imagePresentation";

describe("image presentation", () => {
  it("uses a shared cropped-image presentation", () => {
    const presentation = imagePresentation(
      {
        cropWidth: 320,
        cropHeight: 240,
        cropSourceWidth: 640,
        cropSourceHeight: 480,
        cropX: 25,
        cropY: 75,
        align: "left",
        filter: "grayscale(1)",
      },
      { margin: "22px" },
    );

    expect(presentation.frameStyle).toContain("aspect-ratio:320/240");
    expect(presentation.frameStyle).toContain("margin:22px auto 22px 0");
    expect(presentation.imageStyle).toContain("transform:translate(-12.5%,-37.5%)");
    expect(presentation.imageStyle).toContain("filter:grayscale(1)");
  });

  it("rejects filters outside the supported editor options", () => {
    expect(safeImageFilter("url(javascript:alert(1))")).toBe("none");
  });

  it("preserves the saved crop size when legacy images lack source dimensions", () => {
    const presentation = imagePresentation(
      { cropWidth: 285, cropHeight: 275, cropX: 50, cropY: 50 },
      { margin: "0", includeAutoWidth: true },
    );

    expect(presentation.frameStyle).toBeNull();
    expect(presentation.imageStyle).toContain("width:285px");
    expect(presentation.imageStyle).toContain("height:275px");
    expect(presentation.imageStyle).toContain("object-fit:cover");
  });
});
