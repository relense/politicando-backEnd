Rails.application.routes.draw do
  namespace :api do
    namespace :v1 do
      resources :partidos, only: [:index] do
        get 'partie_articles'
        get '/get_ten/:article_id', action: :get_ten
      end
      resources :articles, only: [:index] do
        get 'get_ten'
      end
    end
  end
end
