<cfset prc.banner = loadBanner("homepage", 1, true)>
<cfoutput>
  #encodeForHTML(prc.banner.text)#
</cfoutput>
