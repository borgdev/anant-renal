import type { Metadata } from "next";
import ProductShell from "../product-shell";

export const metadata: Metadata = {
  title: "Executive Outcomes | Renal Swarm Intelligence",
  description: "Clinical, operational, regulatory and economic outcomes across a configurable renal-care enterprise.",
};

export default function ExecutiveOutcomesPage() {
  return <ProductShell initialNav="executive" />;
}
