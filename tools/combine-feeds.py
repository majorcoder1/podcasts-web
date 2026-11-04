#!/usr/bin/env python3
"""Merge several podcast feeds into one RSS file, newest first.

The audio is not copied: every episode still plays from its original host.
Episodes listed in more than one feed appear once.

    python3 tools/combine-feeds.py feeds/apostolic-classics.json

The JSON names the output file, the channel details and the source feeds.
"""
import email.utils
import json
from datetime import datetime
import sys
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ATOM = "{http://www.w3.org/2005/Atom}"
ITUNES = "http://www.itunes.com/dtds/podcast-1.0.dtd"
USER_AGENT = "4thepeople-podcasts/1.0 (+https://podcast.4thepeople.live)"


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        return ET.fromstring(response.read())


def secure(url):
    return "https://" + url[len("http://"):] if url.startswith("http://") else url


def episodes(root):
    """Each episode of an RSS or Atom feed, with its audio link made https."""
    channel = root.find("channel")
    if channel is not None:
        for item in channel.findall("item"):
            enclosure = item.find("enclosure")
            if enclosure is None or not enclosure.get("url"):
                continue
            yield {
                "title": item.findtext("title") or "",
                "date": email.utils.parsedate_to_datetime(item.findtext("pubDate")) if item.findtext("pubDate") else None,
                "description": item.findtext("description") or "",
                "url": secure(enclosure.get("url")),
                "type": enclosure.get("type") or "audio/mpeg",
                "length": enclosure.get("length") or "0",
                "duration": item.findtext(f"{{{ITUNES}}}duration") or "",
            }
        return
    for entry in root.findall(ATOM + "entry"):
        links = [l for l in entry.findall(ATOM + "link") if l.get("rel") == "enclosure"]
        if not links:
            continue
        updated = entry.findtext(ATOM + "updated") or entry.findtext(ATOM + "published")
        yield {
            "title": entry.findtext(ATOM + "title") or "",
            "date": datetime.fromisoformat(updated) if updated else None,
            "description": entry.findtext(ATOM + "summary") or entry.findtext(ATOM + "content") or "",
            "url": secure(links[0].get("href")),
            "type": links[0].get("type") or "audio/mpeg",
            "length": links[0].get("length") or "0",
            "duration": "",
        }


def main(config_path):
    config = json.loads(Path(config_path).read_text())
    seen = {}
    for source in config["sources"]:
        try:
            found = list(episodes(fetch(source)))
        except Exception as error:  # a dead source must not sink the rest
            print(f"skipped {source}: {error}")
            continue
        added = 0
        for episode in found:
            if episode["url"] not in seen:
                seen[episode["url"]] = episode
                added += 1
        print(f"{added:4} new of {len(found):4} from {source}")

    ET.register_namespace("itunes", ITUNES)
    rss = ET.Element("rss", {"version": "2.0"})
    channel = ET.SubElement(rss, "channel")
    ET.SubElement(channel, "title").text = config["title"]
    ET.SubElement(channel, "link").text = config["link"]
    ET.SubElement(channel, "description").text = config["description"]
    ET.SubElement(channel, "language").text = "en"
    ET.SubElement(channel, f"{{{ITUNES}}}author").text = config["author"]
    ET.SubElement(channel, f"{{{ITUNES}}}image", {"href": config["image"]})
    image = ET.SubElement(channel, "image")
    ET.SubElement(image, "url").text = config["image"]
    ET.SubElement(image, "title").text = config["title"]
    ET.SubElement(image, "link").text = config["link"]

    newest_first = sorted(seen.values(), key=lambda e: e["date"].timestamp() if e["date"] else 0, reverse=True)
    for episode in newest_first:
        item = ET.SubElement(channel, "item")
        ET.SubElement(item, "title").text = episode["title"]
        ET.SubElement(item, "guid", {"isPermaLink": "false"}).text = episode["url"]
        if episode["date"]:
            ET.SubElement(item, "pubDate").text = email.utils.format_datetime(episode["date"])
        ET.SubElement(item, "description").text = episode["description"]
        ET.SubElement(item, "enclosure", {"url": episode["url"], "type": episode["type"], "length": episode["length"]})
        if episode["duration"]:
            ET.SubElement(item, f"{{{ITUNES}}}duration").text = episode["duration"]

    ET.indent(rss)
    output = Path(config_path).parent.parent / config["output"]
    output.parent.mkdir(parents=True, exist_ok=True)
    ET.ElementTree(rss).write(output, encoding="utf-8", xml_declaration=True)
    print(f"{len(seen)} episodes -> {output}")


if __name__ == "__main__":
    main(sys.argv[1])
