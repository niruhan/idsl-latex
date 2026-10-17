/* Open relocated editor controls through the same project menu as users. */
async function editorOption(page, id) {
  if (await page.locator('#' + id).isHidden() && await page.locator('#editorMenu').isHidden()) await page.locator('#editorMenuButton').click();
  await page.locator('#' + id).click();
}
module.exports = {editorOption};
