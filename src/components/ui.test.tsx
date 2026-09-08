// RTL smoke test — proves the component test harness works end to end.
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmptyState } from "./ui";
import { Search } from "lucide-react";

describe("EmptyState", () => {
  it("renders title and hint", () => {
    render(<EmptyState icon={Search} title="Nothing here" hint="Try again later." />);
    expect(screen.getByText("Nothing here")).toBeDefined();
    expect(screen.getByText("Try again later.")).toBeDefined();
  });
});
