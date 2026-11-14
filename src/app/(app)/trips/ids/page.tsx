/**
 * Old address of Passports and IDs (now the Vault tab). Kept so links in
 * earlier notifications still land in the right place.
 */
import { redirect } from "next/navigation";

export default function OldIdsPage() {
  redirect("/vault");
}
