<?xml version="1.0" encoding="utf-8"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <xsl:output method="html" encoding="utf-8"/>
  <xsl:template match="/rss/channel">
    <html lang="en">
      <head>
        <meta charset="utf-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <title><xsl:value-of select="title"/></title>
        <link rel="stylesheet" href="/feeds/feed.css"/>
      </head>
      <body>
        <main>
          <header>
            <div>
              <h1><xsl:value-of select="title"/></h1>
              <div><xsl:value-of select="count(item)"/> sermons</div>
            </div>
          </header>
          <div class="how">
            This is a podcast feed. To listen, copy this address and add it in the Podcasts app or web player:
            <code>https://podcast.4thepeople.live/feeds/apostolic-classics.xml</code>
          </div>
          <ol>
            <xsl:for-each select="item">
              <li>
                <a href="{enclosure/@url}"><xsl:value-of select="title"/></a><br/>
                <small><xsl:value-of select="substring(pubDate, 6, 11)"/> · <xsl:value-of select="description"/></small>
              </li>
            </xsl:for-each>
          </ol>
        </main>
      </body>
    </html>
  </xsl:template>
</xsl:stylesheet>
