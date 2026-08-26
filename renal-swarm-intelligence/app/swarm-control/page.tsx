import type { Metadata } from "next";
import ProductShell from "../product-shell";

export const metadata: Metadata = {
  title: "Swarm Control | Renal Swarm Intelligence",
  description: "Enterprise renal-care topology, governed agents, next-best actions, policy simulation and event-stream operations.",
};

export default function SwarmControlPage() {
  return <ProductShell initialNav="ecosystem" />;
}
