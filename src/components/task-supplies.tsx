/**
 * "Uses: Washing liquid, Softener" – shown in a task's edit sheet (routine
 * step, zone task or chore) when ticking it uses up supplies. Links to the
 * Supplies screen, where the links are changed.
 */
"use client";

import Link from "next/link";
import { useHousehold } from "@/components/household-context";
import { suppliesForTask } from "@/lib/supplies";
import type { CompletionKind } from "@/lib/types";
import { useSupplies } from "@/lib/use-supplies";

export function TaskSupplies({ kind, taskId }: { kind: CompletionKind; taskId: string }) {
  const { household } = useHousehold();
  const { uses, names } = useSupplies(household.id);
  const products = suppliesForTask(kind, taskId, uses, names);
  if (products.length === 0) return null;
  return (
    <Link href="/household/supplies" className="group row row--link">
      <span className="row__body">
        <span className="row__title">Uses</span>
        <span className="row__subtitle">{products.join(", ")}</span>
      </span>
    </Link>
  );
}
