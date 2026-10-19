import { Redirect } from '@docusaurus/router';
import useBaseUrl from '@docusaurus/useBaseUrl';

/** 中文站首页直接跳转到文档首页。 */
export default function Home() {
  return <Redirect to={useBaseUrl('/docs')} />;
}
