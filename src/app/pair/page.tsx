import { redirect } from "next/navigation";

/** Legacy pairing links now converge on the automatic owner bootstrap. */
export default function PairJarvisPage() {
  redirect("/");
}
