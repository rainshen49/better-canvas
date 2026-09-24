from playwright.sync_api import sync_playwright
with sync_playwright() as p:
  b=p.chromium.launch();pg=b.new_page(viewport={"width":1000,"height":800})
  pg.goto("http://localhost:8799");pg.wait_for_timeout(1500);pg.screenshot(path="due.png",full_page=True)
  pg.click("#tab-mat");pg.wait_for_timeout(300);pg.screenshot(path="mat.png",full_page=True)
  pg.click("[data-f=slides]");pg.wait_for_timeout(300);pg.screenshot(path="slides.png",full_page=True)
