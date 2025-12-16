import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase-server";

export async function GET() {
  const { data, error } = await supabase
    .from("ccps_keywords")
    .select("name")
    .order("name", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const keywords = (data ?? []).map((r: any) => r.name).filter(Boolean);
  return NextResponse.json({ keywords });
}
