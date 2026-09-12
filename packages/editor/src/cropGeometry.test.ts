import { describe, expect, it } from "vitest";

import { cropDraftUpdate, getCropGeometry } from "./cropGeometry";

describe("crop geometry", () => {
  it("derives a bounded centered crop from source dimensions", () => {
    const crop = getCropGeometry({}, { width: 600, height: 400 });

    expect(crop.cropWidth).toBe(516);
    expect(crop.cropHeight).toBe(344);
    expect(crop.cropOffsetX).toBe(42);
    expect(crop.cropOffsetY).toBe(28);
  });

  it("clamps invalid dimensions and persists a complete crop model", () => {
    const crop = getCropGeometry(
      { cropWidth: 900, cropHeight: 0, cropX: -10, cropY: 200 },
      { width: 500, height: 300 },
    );

    expect(crop.cropWidth).toBe(500);
    expect(crop.cropHeight).toBe(300);
    expect(cropDraftUpdate(crop, { cropX: 20 })).toMatchObject({
      cropWidth: 500,
      cropHeight: 300,
      cropX: 20,
      cropSourceWidth: 500,
      cropSourceHeight: 300,
    });
  });
});
