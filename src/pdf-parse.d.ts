// pdf-parse ships no types. We use the subpath import to avoid its debug harness.
declare module "pdf-parse/lib/pdf-parse.js" {
  type PageData = {
    getTextContent: (opts: object) => Promise<{ items: { str: string }[] }>;
  };
  type Options = { pagerender?: (page: PageData) => string | Promise<string> };
  function pdfParse(buffer: Buffer, options?: Options): Promise<{ numpages: number; text: string }>;
  export default pdfParse;
}
