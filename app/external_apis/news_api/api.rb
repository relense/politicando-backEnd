class NewsApi::Api
    include HTTParty
    base_uri 'eventregistry.org'

    def initialize
        @date = DateTime.now
        @actual_date = @date

        @request_params = {
            query: {
                query: "{\"$query\":{\"$and\":[{\"conceptUri\":\"http://en.wikipedia.org/wiki/Politics\"},{\"$or\":[{\"sourceUri\":\"publico.pt\"},{\"sourceUri\":\"cmjornal.pt\"},{\"sourceUri\":\"rtp.pt\"},{\"sourceUri\":\"sicnoticias.sapo.pt\"},{\"sourceUri\":\"expresso.sapo.pt\"},{\"sourceUri\":\"dn.pt\"},{\"sourceUri\":\"observador.pt\"},{\"sourceUri\":\"eco.pt\"}]},{\"dateStart\":\"#{@actual_date.strftime("%Y-%m-%d")}\",\"dateEnd\":\"#{@actual_date.strftime("%Y-%m-%d")}\",\"lang\":\"por\"}]}}",
            	action: "getArticles",
            	dataType: [ "news" ],
            	resultType: "articles",
            	articlesSortBy: "date",
            	articlesCount: 100,
            	articleBodyLen: -1,
              includeArticleImage: true,
                apiKey: ENV["EVENT_REGISTRY_API_KEY"]
            }
        }
    end

    def all_headlines
        self.class.get("/api/v1/article", @request_params)
    end
end
