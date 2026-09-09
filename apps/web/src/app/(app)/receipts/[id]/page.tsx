import { ReceiptDetail } from "../../../../components/ReceiptDetail";

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ReceiptDetail receiptId={id} />;
}
