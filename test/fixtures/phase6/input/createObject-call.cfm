<cfset prc.helper = createObject("component", "models.UserHelper").init()>
<cfoutput>
  #encodeForHTML(prc.helper.describe())#
</cfoutput>
