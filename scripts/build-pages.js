import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { english } from './english.js';
export async function buildPages() {
  const root = new URL('../', import.meta.url);
  const files = ['index.html', 'style.css', 'src/app.js', 'src/audio.js', 'src/dsp.js', 'src/scene.js', 'src/bridge.js', 'src/bridge-ui.js'];
  for (const language of ['en', 'ja']) {
    const output = new URL(language === 'en' ? 'pages/' : 'pages/ja/', root);
    for (const file of files) {
      let source = await readFile(new URL(file, root), 'utf8');
      if (language === 'en' && file !== 'style.css') source = english(source);
      if (file === 'index.html') source = source.replace('</header>', `<a href="${language === 'en' ? './ja/' : '../'}" lang="${language === 'en' ? 'ja' : 'en'}">${language === 'en' ? '日本語' : 'English'}</a></header>`);
      const target = new URL(file, output);
      await mkdir(dirname(fileURLToPath(target)), { recursive: true });
      await writeFile(target, source);
    }
    await mkdir(new URL('vendor/', output), { recursive: true });
    for (const file of ['three.module.js', 'three.core.js']) await copyFile(new URL('node_modules/three/build/' + file, root), new URL('vendor/' + file, output));
    await copyFile(new URL('node_modules/three/LICENSE', root), new URL('vendor/LICENSE', output));
    await copyFile(new URL('LICENSE', root), new URL('LICENSE', output));
  }
  // Local type checking resolves the same bundled modules used by the static build.
  await mkdir(new URL('vendor/', root), { recursive: true });
  await writeFile(new URL('vendor/three.module.d.ts', root), "export * from 'three';\n");
  for (const file of ['three.module.js', 'three.core.js']) await copyFile(new URL('node_modules/three/build/' + file, root), new URL('vendor/' + file, root));
  await writeFile(new URL('pages/.nojekyll', root), '');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildPages(); console.log('Built pages/ (English) and pages/ja/ (Japanese).');
}
