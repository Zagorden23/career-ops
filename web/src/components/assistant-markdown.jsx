import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export default function AssistantMarkdown({ text }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>;
}
