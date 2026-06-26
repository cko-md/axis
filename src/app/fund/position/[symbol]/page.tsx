import { FundPositionPage } from "@/components/fund/FundPositionPage";

export default async function FundPositionRoute({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  return <FundPositionPage symbol={symbol.toUpperCase()} />;
}
