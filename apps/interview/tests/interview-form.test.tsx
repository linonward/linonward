import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InterviewForm } from "@/components/interview-form";
describe("InterviewForm", () => {
  it("shows client validation errors before a network request", () => {
    render(<InterviewForm />);
    fireEvent.click(screen.getByRole("button", { name: /提交我的面试资料/ }));
    expect(screen.getByText("姓名需为 2–50 个字符")).toBeInTheDocument();
    expect(screen.getByText("请确认隐私说明")).toBeInTheDocument();
  });
});
